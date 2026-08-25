# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

"""Bulk edit support for child tables rendered as a Grid on a form (e.g.
Website Settings -> Route Redirects, Customize Form -> Fields).

That "Download, edit offline, Upload" flow used to be hand-rolled entirely in
JavaScript (`frappe.ui.form.Grid.setup_allow_bulk_edit` in grid.js): CSV only,
and every value-type field of the child doctype, with no way to pick a
subset. This module gives it the same building blocks the Data Import tool
(`frappe.core.doctype.data_import`) already relies on -- CSV/Excel readers
and writers from `frappe.utils.csvutils` / `frappe.utils.xlsxutils`, and the
same `Insert New Records` / `Update Existing Records` / `Insert or Update
Records` import types the Importer (`importer.py`) uses -- so it gains Excel
support, a column picker, and ID-matched updates without re-implementing any
of that a second time.

Unlike the Data Import tool, row data here always comes from the browser: a
Grid can hold unsaved edits on a form that was never submitted, so
`GridBulkEditExporter` only ever serializes the rows it is handed and
`GridBulkEditImporter` only ever parses a file back into rows (plus, for
`build_preview`, checks a row's ID against the *client-supplied* set of
existing row names) -- neither touches the database.
"""

import frappe
from frappe import _
from frappe.core.doctype.data_import.importer import INSERT, UPDATE, UPSERT
from frappe.model import no_value_fields
from frappe.model import table_fields as table_fieldtypes
from frappe.utils import cint, flt
from frappe.utils.csvutils import build_csv_response, read_csv_content
from frappe.utils.data import evaluate_filters, getdate
from frappe.utils.file_manager import safe_b64decode
from frappe.utils.xlsxutils import build_xlsx_response, read_xlsx_file_from_attached_file

#: title, labels, fieldnames, descriptions, 2 instructions, separator
HEADER_ROW_COUNT = 7
MAX_ROWS = 5000

#: pseudo docfield for a child row's `name` -- not a real field of the child
#: doctype's meta, but (mirroring `DataExporter`'s "ID" column) offered as one
#: in the column picker for `Update Existing Records` / `Insert or Update
#: Records`, so a template can identify which existing row a line is for.
ID_FIELDNAME = "name"

#: "Export Type" -- which of the grid's rows land in the downloaded template.
#: Same four options (and the same values) `DataExporter` offers for the real
#: Data Import tool, so the two pickers stay recognisably the same feature.
EXPORT_ALL = "all"
EXPORT_BY_FILTER = "by_filter"
EXPORT_FEW_RECORDS = "5_records"
EXPORT_BLANK_TEMPLATE = "blank_template"
#: how many rows "5 Records" exports (named so the label and the slice agree)
FEW_RECORD_COUNT = 5


def select_export_rows(
	rows: list[dict],
	export_records: str | None,
	export_filters: list | None,
	child_doctype: str,
) -> list[dict]:
	"""Narrow the grid's rows down to whatever "Export Type" asked for.

	`DataExporter` resolves the same four options with a database query; here
	the rows arrive from the browser (the grid may hold unsaved edits), so the
	equivalent selection happens in memory -- filter matching included, via the
	same `frappe.utils.data.evaluate_filters` the rest of the framework uses,
	rather than a second hand-rolled filter evaluator.

	Both `download_template` and `get_export_row_count` go through here, so the
	"N records will be exported" message can never disagree with what the
	download actually contains.
	"""
	rows = rows or []

	if export_records == EXPORT_BLANK_TEMPLATE:
		return []
	if export_records == EXPORT_FEW_RECORDS:
		return rows[:FEW_RECORD_COUNT]
	if export_records == EXPORT_BY_FILTER:
		if not export_filters:
			return rows
		# evaluate_filters reads `doctype` off the row to resolve each field's
		# type for casting; grid rows carry it, but don't rely on that
		return [row for row in rows if evaluate_filters({**row, "doctype": child_doctype}, export_filters)]
	return rows


def is_bulk_editable(df) -> bool:
	"""A field is offered in the column picker / round-tripped through the
	template if it holds an actual value. Mirrors the filter
	`get_columns_for_picker` applies client-side in data_exporter.js, and the
	`is_exportable` check `Exporter.get_exportable_fields` applies for the
	full Data Import tool, so the three stay in sync."""
	return (
		df.fieldtype not in no_value_fields
		and df.fieldname not in ("lft", "rgt")
		and not df.get("is_virtual")
	)


def get_child_doctype(doctype: str, fieldname: str) -> str:
	table_df = frappe.get_meta(doctype).get_field(fieldname)
	if not table_df or table_df.fieldtype not in table_fieldtypes:
		frappe.throw(_("{0} is not a table field of {1}").format(fieldname, doctype))
	return table_df.options


def check_grid_permission(doctype: str, docname: str | None, ptype: str):
	"""Child tables carry no permissions of their own -- access is governed
	entirely by the parent document (or, for a document that hasn't been
	saved yet, by the parent doctype's create permission)."""
	if docname and frappe.db.exists(doctype, docname):
		frappe.get_doc(doctype, docname).check_permission(ptype)
	else:
		frappe.has_permission(doctype, ptype if ptype != "write" else "create", throw=True)


class GridBulkEditTemplate:
	"""Common ground between the exporter and importer: which fields of the
	child doctype are eligible for bulk edit, plus the synthetic "ID" column
	used to match a template row to an existing grid row."""

	def __init__(self, child_doctype: str, import_type: str | None = None):
		self.child_doctype = child_doctype
		self.meta = frappe.get_meta(child_doctype)
		self.import_type = import_type or INSERT

	def get_importable_fields(self):
		return [df for df in self.meta.fields if is_bulk_editable(df)]

	def get_field(self, fieldname: str):
		if fieldname == ID_FIELDNAME:
			return frappe._dict(fieldname=ID_FIELDNAME, label=_("ID"), fieldtype="Data", reqd=1)
		return self.meta.get_field(fieldname)

	def offers_id_column(self) -> bool:
		# Matching an uploaded row to an existing one by ID only makes sense
		# once there might *be* an existing row to match -- never for a pure
		# insert.
		return self.import_type != INSERT


class GridBulkEditExporter(GridBulkEditTemplate):
	"""Turns the rows of an in-memory (possibly unsaved) child table into a
	downloadable CSV/Excel bulk-edit template, limited to the columns the
	user picked."""

	def __init__(
		self,
		child_doctype: str,
		fieldnames: list[str] | None,
		rows: list[dict],
		title: str | None = None,
		import_type: str | None = None,
	):
		super().__init__(child_doctype, import_type)
		importable_fields = self.get_importable_fields()
		valid_fieldnames = {df.fieldname for df in importable_fields}
		if self.offers_id_column():
			valid_fieldnames.add(ID_FIELDNAME)

		if fieldnames:
			# never trust caller-supplied fieldnames outright -- keep the caller's
			# order, but drop anything that isn't actually a bulk-editable field of
			# this child doctype (or the ID column, when offered)
			self.fieldnames = [fieldname for fieldname in fieldnames if fieldname in valid_fieldnames]
		else:
			self.fieldnames = [df.fieldname for df in importable_fields]
			if self.offers_id_column():
				self.fieldnames = [ID_FIELDNAME, *self.fieldnames]
		self.docfields = [self.get_field(fieldname) for fieldname in self.fieldnames]
		self.rows = rows or []
		self.title = title or _(child_doctype)

	def get_data(self) -> list[list]:
		return [*self.build_header(), *self.build_data_rows()]

	def build_header(self) -> list[list]:
		return [
			[_("Bulk Edit {0}").format(self.title)],
			[_(df.label or df.fieldname) for df in self.docfields],
			[df.fieldname for df in self.docfields],
			[self.get_description(df) for df in self.docfields],
			[_("The CSV format is case sensitive")],
			[_("Do not edit headers which are preset in the template")],
			["------"],
		]

	def get_description(self, df) -> str:
		description = df.description or ""
		if df.fieldtype == "Date":
			from frappe.utils.data import get_user_date_format

			description = f"{description} {get_user_date_format()}".strip()
		return description

	def build_data_rows(self) -> list[list]:
		return [[self.get_cell_value(row, fieldname) for fieldname in self.fieldnames] for row in self.rows]

	def get_cell_value(self, row: dict, fieldname: str):
		value = row.get(fieldname)
		return "" if value is None else value

	def build_response(self, file_type: str = "Excel"):
		data = self.get_data()
		if file_type == "Excel":
			build_xlsx_response(data, self.title)
		else:
			build_csv_response(data, self.title)


class GridBulkEditImporter(GridBulkEditTemplate):
	"""Reads a CSV/Excel bulk-edit template back into row data the Grid can
	use, either as plain parsed dicts (`parse_rows`, used internally and by
	tests) or as a full preview -- column-mapping status and row/column
	warnings alongside those same parsed rows (`build_preview`, used by
	`GridBulkEditPreviewDialog` on the client)."""

	def read_file(self, file_type: str, fcontent: bytes) -> list[list]:
		if file_type == "Excel":
			return read_xlsx_file_from_attached_file(fcontent=fcontent) or []
		return read_csv_content(fcontent) or []

	def parse_rows(self, rows: list[list], warnings: list[dict] | None = None) -> list[dict]:
		if len(rows) <= HEADER_ROW_COUNT:
			return []

		if len(rows) - HEADER_ROW_COUNT > MAX_ROWS:
			frappe.throw(_("Cannot import table with more than {0} rows.").format(MAX_ROWS))

		fieldnames = rows[2]
		parsed_rows = []
		row_number = 0
		for row in rows[HEADER_ROW_COUNT:]:
			if not any(value not in (None, "") for value in row):
				continue
			row_number += 1
			parsed_rows.append(self.parse_row(fieldnames, row, row_number=row_number, warnings=warnings))
		return parsed_rows

	def parse_row(
		self,
		fieldnames: list[str],
		row: list,
		row_number: int | None = None,
		warnings: list[dict] | None = None,
	) -> dict:
		"""Only fieldnames that are actual columns in the file end up in the
		returned dict -- a column the user deselected in the picker is left out
		entirely (so the Grid can tell "not in this template" apart from "cell
		left blank" and leave the row's existing value alone instead of wiping
		it -- see `GridBulkEditPreviewDialog`/`load_bulk_edit_rows` on the
		client)."""
		doc_row = {}
		for fieldname, value in zip(fieldnames, row, strict=False):
			df = fieldname and self.get_field(fieldname)
			if not df or not is_bulk_editable(df):
				continue
			if value in (None, ""):
				doc_row[fieldname] = ""
				continue
			value, warning = self.cast_value(df, value)
			doc_row[fieldname] = value
			if warning and warnings is not None and row_number is not None:
				warnings.append(
					{
						"row": row_number,
						"field": {"fieldname": df.fieldname, "label": _(df.label or df.fieldname)},
						"message": warning,
					}
				)
		return doc_row

	def cast_value(self, df, value):
		if df.fieldtype in ("Int", "Check"):
			return cint(value), None
		if df.fieldtype in ("Float", "Currency", "Percent"):
			return flt(value), None
		if df.fieldtype == "Date" and isinstance(value, str):
			return self.parse_date(value)
		return value, None

	def parse_date(self, value: str):
		from frappe.utils.data import get_user_date_format

		date_format = get_user_date_format().lower()
		day_first = date_format.find("d") < date_format.find("m")
		try:
			return getdate(value, parse_day_first=day_first), None
		except Exception:
			# leave the raw value in place; report it as a warning instead of
			# silently letting the Grid/form surface it as a validation error
			# only after the user has already committed the upload
			return value, _("Could not read date value {0}; expected format {1}").format(
				value, get_user_date_format()
			)

	def build_columns(self, header_titles: list, header_fieldnames: list) -> list[dict]:
		columns = []
		for i, fieldname in enumerate(header_fieldnames):
			title = header_titles[i] if i < len(header_titles) else ""
			df = fieldname and self.get_field(fieldname)
			matched = bool(df) and is_bulk_editable(df)
			columns.append(
				{
					"index": i,
					"fieldname": fieldname if matched else None,
					"header_title": title or fieldname or "",
					"reqd": bool(matched and df.reqd),
				}
			)
		return columns

	def apply_column_overrides(self, header_fieldnames: list, column_to_field_map: dict | None) -> list:
		"""Used by the "Map Columns" step of the preview: reassign (or blank
		out, via "Don't Import") the field a column in the uploaded file maps
		to, without needing the file to be re-uploaded."""
		if not column_to_field_map:
			return header_fieldnames
		header_fieldnames = list(header_fieldnames)
		for index, fieldname in column_to_field_map.items():
			index = cint(index)
			if 0 <= index < len(header_fieldnames):
				header_fieldnames[index] = None if fieldname == "Don't Import" else fieldname
		return header_fieldnames

	def validate_rows(self, rows: list[dict], existing_names: list[str], warnings: list[dict]):
		existing_names = set(existing_names)
		mandatory_fields = [df for df in self.get_importable_fields() if df.reqd]

		for row_number, row in enumerate(rows, start=1):
			if self.offers_id_column():
				self.validate_row_id(row, row_number, existing_names, warnings)
			for df in mandatory_fields:
				# only a problem if the column *was* in the template and left
				# blank (an explicit clear) -- a column the user didn't select
				# is simply absent from `row`, and leaves the existing value alone
				if df.fieldname in row and not row[df.fieldname]:
					warnings.append(
						{
							"row": row_number,
							"field": {"fieldname": df.fieldname, "label": _(df.label or df.fieldname)},
							"message": _("{0} is mandatory").format(_(df.label or df.fieldname)),
						}
					)

	def validate_row_id(self, row: dict, row_number: int, existing_names: set[str], warnings: list[dict]):
		row_id = row.get(ID_FIELDNAME)
		if not row_id:
			if self.import_type == UPDATE:
				warnings.append(
					{
						"row": row_number,
						"message": _(
							"No ID given; this row cannot be matched to an existing row and will be skipped."
						),
					}
				)
			return

		if row_id in existing_names:
			return

		message = (
			_("ID {0} does not match any existing row; this row will be skipped.").format(row_id)
			if self.import_type == UPDATE
			else _("ID {0} does not match any existing row; a new row will be inserted.").format(row_id)
		)
		warnings.append({"row": row_number, "message": message})

	def build_preview(
		self,
		file_type: str,
		fcontent: bytes,
		existing_names: list[str] | None = None,
		column_to_field_map: dict | None = None,
	) -> dict:
		raw_rows = self.read_file(file_type, fcontent)
		if len(raw_rows) <= HEADER_ROW_COUNT:
			return {"columns": [], "data": [], "rows": [], "warnings": [], "total_number_of_rows": 0}

		header_titles = raw_rows[1]
		header_fieldnames = self.apply_column_overrides(raw_rows[2], column_to_field_map)
		columns = self.build_columns(header_titles, header_fieldnames)

		warnings = []
		for column in columns:
			if column["fieldname"] is None and column["header_title"]:
				warnings.append(
					{
						"col": column["index"],
						"message": _("Column not recognized and will be ignored: {0}").format(
							column["header_title"]
						),
					}
				)

		# re-parse with the (possibly remapped) fieldname row -- reuses all of
		# `parse_rows`'s row filtering/casting instead of duplicating it here
		overridden_rows = [*raw_rows[:2], header_fieldnames, *raw_rows[3:]]
		rows = self.parse_rows(overridden_rows, warnings=warnings)
		self.validate_rows(rows, existing_names or [], warnings)

		data_rows = [
			row for row in raw_rows[HEADER_ROW_COUNT:] if any(value not in (None, "") for value in row)
		]
		return {
			"columns": columns,
			"data": [[i + 1, *row] for i, row in enumerate(data_rows)],
			"rows": rows,
			"warnings": warnings,
			"total_number_of_rows": len(rows),
		}


def _decode_dataurl(dataurl: str) -> bytes:
	# `data:<mime>;base64,<content>` -- see FileUploader's `as_dataurl` output
	content = dataurl.rsplit(",", 1)[-1]
	return safe_b64decode(content.encode())


@frappe.whitelist()
def download_template(
	doctype: str,
	fieldname: str,
	rows: str | list[dict] | None = None,
	columns: str | list[str] | None = None,
	file_type: str = "Excel",
	docname: str | None = None,
	import_type: str | None = None,
	export_records: str | None = None,
	export_filters: str | list | None = None,
):
	"""Build a bulk-edit template for one child table field, from the row
	data the browser currently holds for it (which may include unsaved
	edits), narrowed down by "Export Type"."""
	check_grid_permission(doctype, docname, "read")

	child_doctype = get_child_doctype(doctype, fieldname)
	rows = frappe.parse_json(rows) or []
	columns = frappe.parse_json(columns)
	export_filters = frappe.parse_json(export_filters)
	rows = select_export_rows(rows, export_records, export_filters, child_doctype)

	exporter = GridBulkEditExporter(child_doctype, columns, rows, import_type=import_type)
	exporter.build_response(file_type)


@frappe.whitelist()
def get_export_row_count(
	doctype: str,
	fieldname: str,
	rows: str | list[dict] | None = None,
	docname: str | None = None,
	export_records: str | None = None,
	export_filters: str | list | None = None,
) -> int:
	"""How many rows the current "Export Type" would put in the template --
	backs the "{0} records will be exported" hint, using the very same
	selection `download_template` will apply."""
	check_grid_permission(doctype, docname, "read")

	child_doctype = get_child_doctype(doctype, fieldname)
	rows = frappe.parse_json(rows) or []
	export_filters = frappe.parse_json(export_filters)

	return len(select_export_rows(rows, export_records, export_filters, child_doctype))


@frappe.whitelist()
def parse_uploaded_file(
	doctype: str,
	fieldname: str,
	dataurl: str,
	file_type: str = "CSV",
	docname: str | None = None,
	import_type: str | None = None,
	existing_names: str | list[str] | None = None,
	column_to_field_map: str | dict | None = None,
):
	"""Parse an uploaded bulk-edit template into a preview -- per-column
	mapping status, per-row/column warnings, and the parsed rows themselves,
	ready for the Grid to load once the user confirms. The file is never
	persisted -- `dataurl` is the in-browser base64 content from
	`frappe.ui.FileUploader({ as_dataurl: true })`. `existing_names` (the
	current grid's row names) and `column_to_field_map` (from the "Map
	Columns" step) both come from the browser too, since a Grid may hold
	unsaved edits the database doesn't know about."""
	check_grid_permission(doctype, docname, "write")

	child_doctype = get_child_doctype(doctype, fieldname)
	fcontent = _decode_dataurl(dataurl)
	existing_names = frappe.parse_json(existing_names) or []
	column_to_field_map = frappe.parse_json(column_to_field_map) or {}

	importer = GridBulkEditImporter(child_doctype, import_type=import_type)
	return importer.build_preview(file_type, fcontent, existing_names, column_to_field_map)
