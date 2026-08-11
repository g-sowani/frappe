# Copyright (c) 2025, Frappe Technologies Pvt. Ltd. and Contributors
# License: MIT. See LICENSE

from unittest.mock import patch

import frappe
from frappe.core.doctype.doctype.test_doctype import new_doctype
from frappe.core.page.permission_manager.permission_manager import (
	MAX_BATCH_SIZE,
	apply_changes,
	get_permissions,
)
from frappe.exceptions import FrappeTypeError
from frappe.tests import IntegrationTestCase
from frappe.tests.test_helpers import setup_for_tests

TEST_DOCTYPE_NAMES = ("Test Batch Perm A", "Test Batch Perm B", "Test Batch Perm C")


class TestApplyChanges(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		setup_for_tests()

	def setUp(self):
		self.role = "Sales User"

		# apply_changes() commits per item, which flushes past this test's
		# rollback/savepoint - self-heal from any doctype left over by a
		# previous run before creating fresh ones.
		self._delete_test_doctypes()

		# has an existing rule for self.role, so "update" actions have something to act on
		self.doctype_a = (
			new_doctype(
				"Test Batch Perm A",
				permissions=[{"role": "System Manager", "read": 1}, {"role": self.role, "read": 1}],
			)
			.insert()
			.name
		)

		# exactly one Custom DocPerm rule in total, for the "last rule" guard tests
		self.doctype_b = (
			new_doctype(
				"Test Batch Perm B",
				permissions=[{"role": self.role, "read": 1}],
			)
			.insert()
			.name
		)

		# exactly one Custom DocPerm rule, dedicated to the add-before-remove ordering test
		self.doctype_c = (
			new_doctype(
				"Test Batch Perm C",
				permissions=[{"role": self.role, "read": 1}],
			)
			.insert()
			.name
		)

	def tearDown(self):
		frappe.set_user("Administrator")
		# apply_changes() commits, so these doctypes are real rows now, not
		# rolled back automatically - clean them up explicitly.
		self._delete_test_doctypes()

	def _delete_test_doctypes(self):
		for name in TEST_DOCTYPE_NAMES:
			# Custom DocPerm is only linked to a DocType by convention (its `parent`
			# field), not a real child table - deleting the DocType doesn't cascade
			# to it, so a stale row here would silently outlive the doctype it
			# described and leak into the next test that reuses this name.
			#
			# Deleted one-by-one via frappe.delete_doc (not a raw frappe.db.delete)
			# so Custom DocPerm's own on_update/after_delete hooks - including the
			# doctype cache clear - actually fire, the same as they would for any
			# real removal outside a test.
			for docperm_name in frappe.get_all("Custom DocPerm", filters={"parent": name}, pluck="name"):
				frappe.delete_doc("Custom DocPerm", docperm_name, force=True, ignore_permissions=True)
			if frappe.db.exists("DocType", name):
				frappe.delete_doc("DocType", name, force=True, ignore_permissions=True)
			frappe.clear_cache(doctype=name)
		frappe.db.commit()

	def test_batch_applies_across_multiple_doctypes(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			},
			{
				"action": "update",
				"doctype": self.doctype_b,
				"role": self.role,
				"permlevel": 0,
				"ptype": "delete",
				"value": 1,
			},
		]
		result = apply_changes(changes)

		self.assertEqual(
			result["results"],
			[{"index": 0, "ok": True, "error": None}, {"index": 1, "ok": True, "error": None}],
		)
		self.assertEqual(
			frappe.db.get_value("Custom DocPerm", {"parent": self.doctype_a, "role": self.role}, "write"), 1
		)
		self.assertEqual(
			frappe.db.get_value("Custom DocPerm", {"parent": self.doctype_b, "role": self.role}, "delete"), 1
		)

	def test_validate_and_cache_clear_run_once_per_doctype(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			},
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "delete",
				"value": 1,
			},
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "create",
				"value": 1,
			},
		]

		with (
			patch(
				"frappe.core.page.permission_manager.permission_manager.validate_permissions_for_doctype"
			) as mock_validate,
			patch(
				"frappe.core.page.permission_manager.permission_manager.clear_permissions_cache"
			) as mock_clear,
		):
			result = apply_changes(changes)

		self.assertTrue(all(r["ok"] for r in result["results"]))
		mock_validate.assert_called_once_with(self.doctype_a)
		mock_clear.assert_called_once_with(self.doctype_a)

	def test_partial_failure_does_not_block_other_items(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "print",
				"value": 1,
			},
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "report",
				"value": "1",
				"if_owner": "1",
			},
		]
		result = apply_changes(changes)

		self.assertEqual(result["results"][0], {"index": 0, "ok": True, "error": None})
		self.assertFalse(result["results"][1]["ok"])
		self.assertIn("Only If Creator", result["results"][1]["error"])
		self.assertEqual(
			frappe.db.get_value("Custom DocPerm", {"parent": self.doctype_a, "role": self.role}, "print"), 1
		)

	def test_add_runs_before_remove_regardless_of_input_order(self):
		# input lists "remove" first, but doctype_c only has one rule (self.role) -
		# if remove ran first, it would hit the "must have at least one rule" guard.
		# add-before-remove ordering means the new "Sales Manager" rule exists by
		# the time the removal runs, so both succeed.
		changes = [
			{"action": "remove", "doctype": self.doctype_c, "role": self.role, "permlevel": 0},
			{"action": "add", "doctype": self.doctype_c, "role": "Sales Manager", "permlevel": 0},
		]
		result = apply_changes(changes)

		self.assertTrue(all(r["ok"] for r in result["results"]))
		remaining_roles = frappe.get_all("Custom DocPerm", filters={"parent": self.doctype_c}, pluck="role")
		self.assertEqual(remaining_roles, ["Sales Manager"])

	def test_remove_last_rule_without_replacement_fails_that_item_only(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			},
			{"action": "remove", "doctype": self.doctype_b, "role": self.role, "permlevel": 0},
		]
		result = apply_changes(changes)

		self.assertTrue(result["results"][0]["ok"])
		self.assertFalse(result["results"][1]["ok"])
		self.assertIn("atleast one permission rule", result["results"][1]["error"])

		# The blocked remove() lazily creates a Custom DocPerm row via
		# setup_custom_perms() before its guard check fires, then apply_changes()
		# rolls that whole uncommitted item back along with the blocked delete -
		# so Custom DocPerm itself can legitimately end up empty again. That's
		# fine: get_permissions() (what the UI actually renders) falls back to
		# the DocType's own DocPerm when Custom DocPerm is empty, so the role's
		# permission is still effectively intact either way - assert on that
		# real behavior instead of the Custom DocPerm implementation detail.
		perms = get_permissions(doctype=self.doctype_b)
		self.assertTrue(any(p.role == self.role for p in perms))

	def test_requires_system_manager(self):
		frappe.set_user("test2@example.com")
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			}
		]
		self.assertRaises(frappe.PermissionError, apply_changes, changes)

	def test_batch_size_cap(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			}
		] * (MAX_BATCH_SIZE + 1)
		self.assertRaises(frappe.ValidationError, apply_changes, changes)

	def test_empty_batch_is_a_noop(self):
		self.assertEqual(apply_changes([]), {"results": []})

	def test_permlevel_above_zero(self):
		# new_doctype() auto-grants basic CRUD (read/write/create) to every listed
		# role at permlevel 0, and Custom DocPerm for a role/permlevel is only
		# lazily materialized on first touch (setup_custom_perms -> copy_perms) -
		# querying it directly before that touch returns None (no row), not
		# "found with write=0". get_permissions() (the real production function,
		# same Custom-DocPerm-or-DocPerm fallback the UI relies on) gives the
		# true effective value regardless of materialization timing, so use it
		# for the baseline instead of a raw Custom DocPerm lookup.
		def get_permlevel_0_write():
			perms = get_permissions(doctype=self.doctype_a)
			row = next(p for p in perms if p.role == self.role and p.permlevel == 0)
			return row.write

		permlevel_0_write_before = get_permlevel_0_write()

		changes = [
			{"action": "add", "doctype": self.doctype_a, "role": self.role, "permlevel": 1},
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 1,
				"ptype": "write",
				"value": 1,
			},
		]
		result = apply_changes(changes)

		self.assertTrue(all(r["ok"] for r in result["results"]))
		self.assertEqual(
			frappe.db.get_value(
				"Custom DocPerm", {"parent": self.doctype_a, "role": self.role, "permlevel": 1}, "write"
			),
			1,
		)
		# the permlevel-0 row for the same role is untouched by the permlevel-1 change
		self.assertEqual(get_permlevel_0_write(), permlevel_0_write_before)

	def test_malformed_change_missing_ptype_reports_clean_error(self):
		changes = [
			{"action": "update", "doctype": self.doctype_a, "role": self.role, "permlevel": 0},
		]
		result = apply_changes(changes)

		self.assertFalse(result["results"][0]["ok"])
		self.assertIn("ptype", result["results"][0]["error"])

	def test_non_list_changes_raises_clean_error(self):
		# rejected by frappe's own whitelist type-coercion (str | list) before
		# our function body runs, so this is a FrappeTypeError, not our
		# own frappe.throw ValidationError
		self.assertRaises(FrappeTypeError, apply_changes, {"action": "update"})

	def test_non_dict_item_in_list_reports_clean_error_without_blocking_others(self):
		changes = [
			{
				"action": "update",
				"doctype": self.doctype_a,
				"role": self.role,
				"permlevel": 0,
				"ptype": "write",
				"value": 1,
			},
			"not-a-dict",
		]
		result = apply_changes(changes)

		self.assertTrue(result["results"][0]["ok"])
		self.assertFalse(result["results"][1]["ok"])
		self.assertIn("object", result["results"][1]["error"])
