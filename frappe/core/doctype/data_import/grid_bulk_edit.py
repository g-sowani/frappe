# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

"""Bulk edit support for child tables rendered as a Grid on a form (e.g.
Website Settings -> Route Redirects, Customize Form -> Fields).

That "Download, edit offline, Upload" flow used to be hand-rolled entirely in
JavaScript (`frappe.ui.form.Grid.setup_allow_bulk_edit` in grid.js): CSV only,
and every value-type field of the child doctype, with no way to pick a
subset. This module gives it the same building blocks the Data Import tool
(`frappe.core.doctype.data_import`) already relies on -- CSV/Excel readers
and writers from `frappe.utils.csvutils` / `frappe.utils.xlsxutils` -- so it
gains Excel support and a column picker without re-implementing CSV
parsing/writing a second time.

Unlike the Data Import tool, row data here always comes from the browser: a
Grid can hold unsaved edits on a form that was never submitted, so
`GridBulkEditExporter` only ever serializes the rows it is handed and
`GridBulkEditImporter` only ever parses a file back into rows -- neither
touches the database.
"""

import frappe
from frappe import _
from frappe.model import no_value_fields
from frappe.model import table_fields as table_fieldtypes
from frappe.utils import cint, flt
from frappe.utils.csvutils import build_csv_response, read_csv_content
from frappe.utils.data import getdate
from frappe.utils.file_manager import safe_b64decode
from frappe.utils.xlsxutils import build_xlsx_response, read_xlsx_file_from_attached_file

#: title, labels, fieldnames, descriptions, 2 instructions, separator
HEADER_ROW_COUNT = 7
MAX_ROWS = 5000


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
	child doctype are eligible for bulk edit."""

	def __init__(self, child_doctype: str):
		self.child_doctype = child_doctype
		self.meta = frappe.get_meta(child_doctype)

	def get_importable_fields(self):
		return [df for df in self.meta.fields if is_bulk_editable(df)]

	def get_field(self, fieldname: str):
		return self.meta.get_field(fieldname)


class GridBulkEditExporter(GridBulkEditTemplate):
	"""Turns the rows of an in-memory (possibly unsaved) child table into a
	downloadable CSV/Excel bulk-edit template, limited to the columns the
	user picked."""

	def __init__(
		self, child_doctype: str, fieldnames: list[str] | None, rows: list[dict], title: str | None = None
	):
		super().__init__(child_doctype)
		importable_fields = self.get_importable_fields()
		if fieldnames:
			# never trust caller-supplied fieldnames outright -- keep the caller's
			# order, but drop anything that isn't actually a bulk-editable field of
			# this child doctype
			valid_fieldnames = {df.fieldname for df in importable_fields}
			self.fieldnames = [fieldname for fieldname in fieldnames if fieldname in valid_fieldnames]
		else:
			self.fieldnames = [df.fieldname for df in importable_fields]
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
	"""Reads a CSV/Excel bulk-edit template back into a list of row dicts the
	Grid can drop straight into the child table."""

	def parse_file(self, file_type: str, fcontent: bytes) -> list[dict]:
		if file_type == "Excel":
			rows = read_xlsx_file_from_attached_file(fcontent=fcontent) or []
		else:
			rows = read_csv_content(fcontent) or []
		return self.parse_rows(rows)

	def parse_rows(self, rows: list[list]) -> list[dict]:
		if len(rows) <= HEADER_ROW_COUNT:
			return []

		if len(rows) - HEADER_ROW_COUNT > MAX_ROWS:
			frappe.throw(_("Cannot import table with more than {0} rows.").format(MAX_ROWS))

		fieldnames = rows[2]
		return [
			self.parse_row(fieldnames, row)
			for row in rows[HEADER_ROW_COUNT:]
			if any(value not in (None, "") for value in row)
		]

	def parse_row(self, fieldnames: list[str], row: list) -> dict:
		"""Only fieldnames that are actual columns in the file end up in the
		returned dict -- a column the user deselected in the picker is left out
		entirely (so the Grid can tell "not in this template" apart from "cell
		left blank" and leave the row's existing value alone instead of wiping
		it -- see `GridBulkEditDialog`/`load_bulk_edit_rows` on the client)."""
		doc_row = {}
		for fieldname, value in zip(fieldnames, row, strict=False):
			df = fieldname and self.get_field(fieldname)
			if not df or not is_bulk_editable(df):
				continue
			doc_row[fieldname] = self.cast_value(df, value) if value not in (None, "") else ""
		return doc_row

	def cast_value(self, df, value):
		if df.fieldtype in ("Int", "Check"):
			return cint(value)
		if df.fieldtype in ("Float", "Currency", "Percent"):
			return flt(value)
		if df.fieldtype == "Date" and isinstance(value, str):
			return self.parse_date(value)
		return value

	def parse_date(self, value: str):
		from frappe.utils.data import get_user_date_format

		date_format = get_user_date_format().lower()
		day_first = date_format.find("d") < date_format.find("m")
		try:
			return getdate(value, parse_day_first=day_first)
		except Exception:
			# leave the raw value in place; the Grid/form will surface the
			# bad value as a normal validation error on save
			return value


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
):
	"""Build a bulk-edit template for one child table field, from the row
	data the browser currently holds for it (which may include unsaved
	edits)."""
	check_grid_permission(doctype, docname, "read")

	child_doctype = get_child_doctype(doctype, fieldname)
	rows = frappe.parse_json(rows) or []
	columns = frappe.parse_json(columns)

	exporter = GridBulkEditExporter(child_doctype, columns, rows)
	exporter.build_response(file_type)


@frappe.whitelist()
def parse_uploaded_file(
	doctype: str,
	fieldname: str,
	dataurl: str,
	file_type: str = "CSV",
	docname: str | None = None,
):
	"""Parse an uploaded bulk-edit template back into row dicts for the Grid
	to load. The file is never persisted -- `dataurl` is the in-browser
	base64 content from `frappe.ui.FileUploader({ as_dataurl: true })`."""
	check_grid_permission(doctype, docname, "write")

	child_doctype = get_child_doctype(doctype, fieldname)
	fcontent = _decode_dataurl(dataurl)

	importer = GridBulkEditImporter(child_doctype)
	return importer.parse_file(file_type, fcontent)
