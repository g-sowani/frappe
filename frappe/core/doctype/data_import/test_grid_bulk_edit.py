# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

import frappe
from frappe.core.doctype.data_import.grid_bulk_edit import (
	EXPORT_ALL,
	EXPORT_BLANK_TEMPLATE,
	EXPORT_BY_FILTER,
	EXPORT_FEW_RECORDS,
	FEW_RECORD_COUNT,
	MAX_ROWS,
	GridBulkEditExporter,
	GridBulkEditImporter,
	check_grid_permission,
	get_child_doctype,
	select_export_rows,
)
from frappe.core.doctype.data_import.importer import INSERT, UPDATE, UPSERT
from frappe.core.doctype.data_import.test_importer import create_doctype_if_not_exists
from frappe.tests import IntegrationTestCase

doctype_name = "DocType for Grid Bulk Edit"
child_doctype_name = "Child 1 of " + doctype_name


class TestGridBulkEdit(IntegrationTestCase):
	def setUp(self):
		create_doctype_if_not_exists(doctype_name)

	def test_get_child_doctype_resolves_table_field(self):
		self.assertEqual(get_child_doctype(doctype_name, "table_field_1"), child_doctype_name)

	def test_get_child_doctype_rejects_non_table_field(self):
		self.assertRaises(frappe.ValidationError, get_child_doctype, doctype_name, "title")

	def test_get_importable_fields_excludes_no_value_fields(self):
		exporter = GridBulkEditExporter(child_doctype_name, fieldnames=None, rows=[])
		fieldnames = [df.fieldname for df in exporter.get_importable_fields()]
		self.assertEqual(
			fieldnames,
			["child_title", "child_description", "child_date", "child_number", "child_another_number"],
		)

	def test_export_defaults_to_all_importable_columns(self):
		exporter = GridBulkEditExporter(child_doctype_name, fieldnames=None, rows=[])
		self.assertEqual(exporter.fieldnames, [df.fieldname for df in exporter.get_importable_fields()])

	def test_export_limits_to_selected_columns(self):
		rows = [{"child_title": "Row 1", "child_number": 5, "child_description": "ignored"}]
		exporter = GridBulkEditExporter(child_doctype_name, ["child_title", "child_number"], rows)
		data = exporter.get_data()

		self.assertEqual(data[2], ["child_title", "child_number"])  # fieldnames row
		self.assertEqual(data[-1], ["Row 1", 5])

	def test_export_drops_unknown_or_non_editable_fieldnames(self):
		exporter = GridBulkEditExporter(
			child_doctype_name, ["child_title", "not_a_real_field", "parent"], [{"child_title": "Row 1"}]
		)
		self.assertEqual(exporter.fieldnames, ["child_title"])

	def test_export_keeps_falsy_values_distinct_from_blank(self):
		rows = [{"child_number": 0}, {}]
		exporter = GridBulkEditExporter(child_doctype_name, ["child_number"], rows)
		data = exporter.get_data()

		self.assertEqual(data[-2], [0])
		self.assertEqual(data[-1], [""])

	def test_export_then_import_round_trips_row_values(self):
		rows = [
			{"child_title": "Widget", "child_description": "A widget", "child_number": 3},
			{"child_title": "Gadget", "child_number": 0},
		]
		exporter = GridBulkEditExporter(
			child_doctype_name, ["child_title", "child_description", "child_number"], rows
		)
		data = exporter.get_data()

		importer = GridBulkEditImporter(child_doctype_name)
		parsed = importer.parse_rows(data)

		self.assertEqual(
			parsed,
			[
				{"child_title": "Widget", "child_description": "A widget", "child_number": 3},
				# child_description is blank for this row, but the column *was* in
				# the template -- an explicit clear, not "leave it alone" (see
				# test_parse_row_distinguishes_blank_cell_from_missing_column)
				{"child_title": "Gadget", "child_description": "", "child_number": 0},
			],
		)

	def test_parse_row_distinguishes_blank_cell_from_missing_column(self):
		"""Regression test: a column the user deselected in the picker must be
		left out of the parsed row entirely (so the Grid preserves whatever that
		field already had), while a column that *is* present but empty for a
		given row must still come through as an explicit "" (a real clear).
		Conflating the two used to silently blank out every field a bulk-edit
		template didn't include -- e.g. re-uploading a Customize Form "Fields"
		template without a "Label" column wiped every field's label."""
		importer = GridBulkEditImporter(child_doctype_name)

		# only "child_title" and "child_number" are columns in this file;
		# "child_description" was never selected and shouldn't appear at all.
		row = importer.parse_row(["child_title", "child_number"], ["Widget", ""])

		self.assertEqual(row, {"child_title": "Widget", "child_number": ""})
		self.assertNotIn("child_description", row)

	def test_import_ignores_unknown_or_non_editable_columns_in_header(self):
		importer = GridBulkEditImporter(child_doctype_name)
		rows = [
			["Bulk Edit"],
			["Child Title", "Not A Field", "Parent"],
			["child_title", "not_a_real_field", "parent"],
			[""],
			["note"],
			["note2"],
			["------"],
			["Widget", "junk", "SomeParent"],
		]

		parsed = importer.parse_rows(rows)
		self.assertEqual(parsed, [{"child_title": "Widget"}])

	def test_import_skips_fully_blank_rows(self):
		importer = GridBulkEditImporter(child_doctype_name)
		header = GridBulkEditExporter(child_doctype_name, ["child_title"], []).build_header()
		rows = [*header, ["Widget"], ["", ""], []]

		parsed = importer.parse_rows(rows)
		self.assertEqual(parsed, [{"child_title": "Widget"}])

	def test_import_rejects_too_many_rows(self):
		importer = GridBulkEditImporter(child_doctype_name)
		header = GridBulkEditExporter(child_doctype_name, ["child_title"], []).build_header()
		rows = [*header, *[["Row"]] * (MAX_ROWS + 1)]

		self.assertRaises(frappe.ValidationError, importer.parse_rows, rows)

	def test_check_grid_permission_allows_system_manager(self):
		# System Manager has full access; this should simply not raise, whether or
		# not the parent document (or a docname at all) exists yet.
		check_grid_permission(doctype_name, None, "read")
		check_grid_permission(doctype_name, "new-does-not-exist", "write")

	# -- import_type / ID column -------------------------------------------------

	def test_export_omits_id_column_for_insert(self):
		exporter = GridBulkEditExporter(child_doctype_name, fieldnames=None, rows=[], import_type=INSERT)
		self.assertNotIn("name", exporter.fieldnames)

	def test_export_prepends_id_column_for_update_and_upsert(self):
		for import_type in (UPDATE, UPSERT):
			exporter = GridBulkEditExporter(
				child_doctype_name, fieldnames=None, rows=[], import_type=import_type
			)
			self.assertEqual(exporter.fieldnames[0], "name")

	def test_export_keeps_id_column_when_explicitly_selected(self):
		rows = [{"name": "row-1", "child_title": "Widget"}]
		exporter = GridBulkEditExporter(child_doctype_name, ["name", "child_title"], rows, import_type=UPDATE)
		data = exporter.get_data()
		self.assertEqual(data[2], ["name", "child_title"])
		self.assertEqual(data[-1], ["row-1", "Widget"])

	def test_export_drops_id_column_for_insert_even_if_requested(self):
		exporter = GridBulkEditExporter(child_doctype_name, ["name", "child_title"], [], import_type=INSERT)
		self.assertEqual(exporter.fieldnames, ["child_title"])

	def test_import_reads_id_column_when_offered(self):
		importer = GridBulkEditImporter(child_doctype_name, import_type=UPDATE)
		row = importer.parse_row(["name", "child_title"], ["row-1", "Widget"])
		self.assertEqual(row, {"name": "row-1", "child_title": "Widget"})

	# -- Export Type (select_export_rows) ----------------------------------------

	def make_export_rows(self):
		return [
			{"child_title": f"Row {i}", "child_number": i, "doctype": child_doctype_name} for i in range(1, 8)
		]

	def test_export_all_returns_every_row(self):
		rows = self.make_export_rows()
		self.assertEqual(select_export_rows(rows, EXPORT_ALL, None, child_doctype_name), rows)

	def test_export_defaults_to_all_when_type_missing(self):
		rows = self.make_export_rows()
		self.assertEqual(select_export_rows(rows, None, None, child_doctype_name), rows)

	def test_export_blank_template_drops_all_rows(self):
		rows = self.make_export_rows()
		self.assertEqual(select_export_rows(rows, EXPORT_BLANK_TEMPLATE, None, child_doctype_name), [])

	def test_export_few_records_caps_at_five(self):
		rows = self.make_export_rows()
		selected = select_export_rows(rows, EXPORT_FEW_RECORDS, None, child_doctype_name)
		self.assertEqual(len(selected), FEW_RECORD_COUNT)
		self.assertEqual([row["child_number"] for row in selected], [1, 2, 3, 4, 5])

	def test_export_few_records_on_short_table_returns_what_there_is(self):
		rows = self.make_export_rows()[:2]
		self.assertEqual(select_export_rows(rows, EXPORT_FEW_RECORDS, None, child_doctype_name), rows)

	def test_export_by_filter_matches_rows(self):
		rows = self.make_export_rows()
		selected = select_export_rows(
			rows, EXPORT_BY_FILTER, [[child_doctype_name, "child_number", ">", 5]], child_doctype_name
		)
		self.assertEqual([row["child_number"] for row in selected], [6, 7])

	def test_export_by_filter_casts_using_fieldtype(self):
		"""The filter value arrives from the browser as a string; evaluate_filters
		casts it against the field's real type, so "5" must match the Int 5."""
		rows = self.make_export_rows()
		selected = select_export_rows(
			rows, EXPORT_BY_FILTER, [[child_doctype_name, "child_number", "=", "5"]], child_doctype_name
		)
		self.assertEqual([row["child_number"] for row in selected], [5])

	def test_export_by_filter_supports_like(self):
		rows = self.make_export_rows()
		selected = select_export_rows(
			rows,
			EXPORT_BY_FILTER,
			[[child_doctype_name, "child_title", "like", "%Row 3%"]],
			child_doctype_name,
		)
		self.assertEqual([row["child_title"] for row in selected], ["Row 3"])

	def test_export_by_filter_without_filters_returns_every_row(self):
		rows = self.make_export_rows()
		self.assertEqual(select_export_rows(rows, EXPORT_BY_FILTER, [], child_doctype_name), rows)

	def test_export_by_filter_works_on_rows_without_doctype_key(self):
		"""Rows come from the browser, so don't assume they carry `doctype` --
		without it evaluate_filters can't resolve the fieldtype to cast against."""
		rows = [{"child_title": "Row 1", "child_number": 1}, {"child_title": "Row 2", "child_number": 2}]
		selected = select_export_rows(
			rows, EXPORT_BY_FILTER, [[child_doctype_name, "child_number", "=", "2"]], child_doctype_name
		)
		self.assertEqual([row["child_title"] for row in selected], ["Row 2"])

	def test_export_handles_empty_rows(self):
		for export_records in (EXPORT_ALL, EXPORT_BY_FILTER, EXPORT_FEW_RECORDS, EXPORT_BLANK_TEMPLATE):
			self.assertEqual(select_export_rows(None, export_records, None, child_doctype_name), [])

	# -- build_preview: columns ---------------------------------------------------

	def make_template_rows(self, fieldnames, data_rows, labels=None):
		header = GridBulkEditExporter(child_doctype_name, fieldnames, []).build_header()
		header[1] = labels or fieldnames
		header[2] = fieldnames
		return [*header, *data_rows]

	def test_preview_columns_flag_unrecognized_header_as_unmatched(self):
		importer = GridBulkEditImporter(child_doctype_name)
		rows = self.make_template_rows(
			["child_title", "not_a_real_field"], [["Widget", "junk"]], labels=["Child Title", "Mystery"]
		)
		columns = importer.build_columns(rows[1], rows[2])
		self.assertEqual(columns[0]["fieldname"], "child_title")
		self.assertEqual(
			columns[1], {"index": 1, "fieldname": None, "header_title": "Mystery", "reqd": False}
		)

	def test_preview_from_csv_reports_unmatched_column_warning(self):
		importer = GridBulkEditImporter(child_doctype_name)
		rows = self.make_template_rows(
			["child_title", "not_a_real_field"], [["Widget", "junk"]], labels=["Child Title", "Mystery"]
		)
		fcontent = self._rows_to_csv_bytes(rows)
		preview = importer.build_preview("CSV", fcontent)

		self.assertEqual(preview["rows"], [{"child_title": "Widget"}])
		self.assertEqual(preview["total_number_of_rows"], 1)
		col_warnings = [w for w in preview["warnings"] if "col" in w]
		self.assertEqual(len(col_warnings), 1)
		self.assertIn("Mystery", col_warnings[0]["message"])

	def test_preview_reports_mandatory_field_left_blank(self):
		importer = GridBulkEditImporter(child_doctype_name)
		# the row can't be fully blank (it would just be skipped as an empty
		# line) -- leave the mandatory column blank while another has a value
		rows = self.make_template_rows(["child_title", "child_number"], [["", "5"]])
		fcontent = self._rows_to_csv_bytes(rows)
		preview = importer.build_preview("CSV", fcontent)

		row_warnings = [w for w in preview["warnings"] if w.get("row") == 1]
		self.assertTrue(any("mandatory" in w["message"] for w in row_warnings))

	def test_preview_update_flags_unmatched_id(self):
		importer = GridBulkEditImporter(child_doctype_name, import_type=UPDATE)
		rows = self.make_template_rows(["name", "child_title"], [["ghost-row", "Widget"]])
		fcontent = self._rows_to_csv_bytes(rows)
		preview = importer.build_preview("CSV", fcontent, existing_names=["real-row"])

		self.assertTrue(
			any("ghost-row" in w["message"] and "skipped" in w["message"] for w in preview["warnings"])
		)

	def test_preview_update_accepts_matching_id_without_warning(self):
		importer = GridBulkEditImporter(child_doctype_name, import_type=UPDATE)
		rows = self.make_template_rows(["name", "child_title"], [["real-row", "Widget"]])
		fcontent = self._rows_to_csv_bytes(rows)
		preview = importer.build_preview("CSV", fcontent, existing_names=["real-row"])

		self.assertEqual(preview["warnings"], [])
		self.assertEqual(preview["rows"], [{"name": "real-row", "child_title": "Widget"}])

	def test_preview_upsert_treats_unmatched_id_as_new_row_not_error(self):
		importer = GridBulkEditImporter(child_doctype_name, import_type=UPSERT)
		rows = self.make_template_rows(["name", "child_title"], [["new-row", "Widget"]])
		fcontent = self._rows_to_csv_bytes(rows)
		preview = importer.build_preview("CSV", fcontent, existing_names=["real-row"])

		self.assertTrue(any("inserted" in w["message"] for w in preview["warnings"]))

	def test_preview_column_to_field_map_remaps_without_reupload(self):
		importer = GridBulkEditImporter(child_doctype_name)
		rows = self.make_template_rows(
			["child_title", "mystery_column"], [["Widget", "42"]], labels=["Child Title", "Mystery"]
		)
		fcontent = self._rows_to_csv_bytes(rows)

		before = importer.build_preview("CSV", fcontent)
		self.assertNotIn("child_number", before["rows"][0])

		after = importer.build_preview("CSV", fcontent, column_to_field_map={"1": "child_number"})
		self.assertEqual(after["rows"], [{"child_title": "Widget", "child_number": 42}])

	def test_preview_of_blank_file_is_empty(self):
		importer = GridBulkEditImporter(child_doctype_name)
		preview = importer.build_preview("CSV", b"")
		self.assertEqual(
			preview, {"columns": [], "data": [], "rows": [], "warnings": [], "total_number_of_rows": 0}
		)

	def _rows_to_csv_bytes(self, rows) -> bytes:
		import csv
		import io

		buf = io.StringIO()
		writer = csv.writer(buf)
		for row in rows:
			writer.writerow(row)
		return buf.getvalue().encode("utf-8")
