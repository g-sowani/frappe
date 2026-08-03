// Copyright (c) 2020, Frappe Technologies and contributors
// For license information, please see license.txt

frappe.ui.form.on("Document Naming Rule", {
	refresh: function (frm) {
		frm.trigger("document_type");
		frm.last_counter_value = frm.doc.counter;
		frm.skip_before_save = false;
	},
	before_save: function (frm) {
		if (frm.is_new() || frm.skip_before_save || frm.last_counter_value === frm.doc.counter)
			return;

		frappe.validated = false;
		frappe.warn(
			__("Are you sure?"),
			__("Updating counter may lead to document name conflicts if not done properly"),
			() => {
				frm.skip_before_save = true;
				frm.save();
			},
			__("Proceed"),
			false
		);
	},
	document_type: (frm) => {
		// update the select field options with fieldnames
		if (frm.doc.document_type) {
			frappe.model.with_doctype(frm.doc.document_type, () => {
				let fieldnames = frappe
					.get_meta(frm.doc.document_type)
					.fields.filter((d) => {
						return frappe.model.no_value_type.indexOf(d.fieldtype) === -1;
					})
					.map((d) => {
						return { label: `${d.label} (${d.fieldname})`, value: d.fieldname };
					});
				frm.fields_dict.conditions.grid.update_docfield_property(
					"field",
					"options",
					fieldnames
				);
			});
		}
	},
});

frappe.ui.form.on("Document Naming Rule Condition", {
	field: function (frm, cdt, cdn) {
		// When field is selected, populate value field options
		const row = locals[cdt][cdn];
		const parent_doc = frm.doc;

		if (!parent_doc.document_type || !row.field) {
			return;
		}

		frappe.call({
			method: "frappe.core.doctype.document_naming_rule.document_naming_rule.get_condition_field_values",
			args: {
				document_type: parent_doc.document_type,
				fieldname: row.field,
			},
			callback: function (r) {
				if (!r.message) {
					return;
				}

				const grid = frm.fields_dict.conditions.grid;
				// keeps df.options current for rows/controls not yet rendered
				grid.update_docfield_property("value", "options", r.message);

				// the current row's "value" control, if already instantiated inline,
				// won't pick up the new df.options on its own, so refresh it directly
				const grid_row = grid.grid_rows_by_docname[cdn];
				const value_field = grid_row && grid_row.columns.value && grid_row.columns.value.field;
				if (value_field) {
					value_field.set_data(r.message);
				}
			},
		});
	},
});
