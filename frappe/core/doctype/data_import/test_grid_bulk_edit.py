# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

import frappe
from frappe.core.doctype.data_import.grid_bulk_edit import (
	MAX_ROWS,
	GridBulkEditExporter,
	GridBulkEditImporter,
	check_grid_permission,
	get_child_doctype,
)
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
