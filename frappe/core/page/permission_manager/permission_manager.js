frappe.pages["permission-manager"].on_page_load = (wrapper) => {
	let page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Role Permissions Manager"),
		card_layout: true,
		single_column: true,
	});

	frappe.breadcrumbs.add("Setup");

	$("<div class='perm-engine' style='min-height: 200px; padding: 15px;'></div>").appendTo(
		page.main
	);
	$(frappe.render_template("permission_manager_help", {})).appendTo(page.main);
	wrapper.permission_engine = new frappe.PermissionEngine(wrapper);
};

frappe.pages["permission-manager"].refresh = function (wrapper) {
	wrapper.permission_engine.set_from_route();
};

frappe.PermissionEngine = class PermissionEngine {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.page = wrapper.page;
		this.body = $(this.wrapper).find(".perm-engine");
		// staged, not-yet-applied changes, keyed so repeated edits to the same
		// checkbox/row collapse into one entry instead of piling up. Kept on
		// `this` (not tied to the current doctype/role filter) so changes
		// staged for one view survive navigating to another - Apply Changes
		// applies everything staged, regardless of what's on screen.
		this.pending_changes = new Map();
		this.make();
		this.refresh();
		this.add_check_events();
	}

	make() {
		this.make_reset_button();
		frappe
			.call({
				module: "frappe.core",
				page: "permission_manager",
				method: "get_roles_and_doctypes",
			})
			.then((res) => {
				this.options = res.message;
				this.setup_page();
			});
	}

	setup_page() {
		this.doctype_select = this.wrapper.page.add_field({
			fieldname: "doctype_select",
			label: __("Document Type"),
			fieldtype: "Link",
			options: "DocType",
			get_query: function () {
				return {
					filters: {
						istable: 0,
					},
				};
			},
			change: function () {
				frappe.set_route("permission-manager", this.get_value());
			},
		});

		this.role_select = this.wrapper.page.add_field({
			fieldname: "role_select",
			label: __("Roles"),
			fieldtype: "Link",
			options: "Role",
			change: () => this.refresh(),
		});

		this.page.add_inner_button(__("Set User Permissions"), () => {
			return frappe.set_route("List", "User Permission");
		});

		this.page.add_inner_button(__("View Activity Log"), () => {
			this.show_activity_log();
		});

		// `add_inner_button` lands in `.custom-actions`, off on the far left of
		// the whole toolbar - not adjacent to Apply Changes. Built by hand
		// instead: created once, inserted immediately before `page.btn_primary`
		// (a stable element `set_primary_action` only relabels in place, so
		// this stays correctly positioned across renders), and just
		// shown/hidden by `update_action_bar()` from then on.
		this.discard_btn = frappe.ui
			.button({
				label: __("Discard Changes"),
				variant: "solid",
				theme: "red",
				onclick: () => this.discard_pending_changes(),
			})
			.insertBefore(this.page.btn_primary)
			.hide();

		this.set_from_route();
	}

	set_from_route() {
		if (!this.doctype_select) {
			// selects not yet loaded, call again after a bit
			setTimeout(() => {
				this.set_from_route();
			}, 500);
			return;
		}
		if (frappe.get_route()[1]) {
			this.doctype_select.set_value(frappe.get_route()[1]);
		} else if (frappe.route_options) {
			if (frappe.route_options.doctype) {
				this.doctype_select.set_value(frappe.route_options.doctype);
			}
			if (frappe.route_options.role) {
				this.role_select.set_value(frappe.route_options.role);
			}
			frappe.route_options = null;
		}
		this.refresh();
	}

	get_standard_permissions(callback) {
		let doctype = this.get_doctype();
		if (doctype) {
			return frappe.call({
				module: "frappe.core",
				page: "permission_manager",
				method: "get_standard_permissions",
				args: { doctype: doctype },
				callback: callback,
			});
		}
		return false;
	}

	reset_std_permissions(data) {
		let doctype = this.get_doctype();
		let d = frappe.confirm(__("Reset Permissions for {0}?", [__(doctype)]), () => {
			return frappe
				.call({
					module: "frappe.core",
					page: "permission_manager",
					method: "reset",
					args: { doctype },
				})
				.then(() => {
					// server state for this doctype just changed underneath any
					// staged edits - drop them rather than reapply them onto rows
					// that no longer mean what they meant when staged
					this.purge_pending_changes_for_doctype(doctype);
					this.refresh();
				});
		});

		// show standard permissions
		let $d = $(d.wrapper)
			.find(".frappe-confirm-message")
			.append(`<hr><h5>${__("Standard Permissions")}:</h5><br>`);
		let $wrapper = $("<p></p>").appendTo($d);
		data.message.forEach((d) => {
			let custom_rights = this.options.doctype_ptype_map[doctype] || [];
			d.rights = this.rights
				.concat(custom_rights)
				.filter((r) => d[r])
				.map((r) => {
					return __(toTitle(frappe.unscrub(r)));
				})
				.join(", ");

			$wrapper.append(`<div class="row">\
				<div class="col-xs-5"><b>${__(d.role)}</b>, ${__("Level")} ${d.permlevel || 0}</div>\
				<div class="col-xs-7 text-break">${d.rights}</div>\
			</div><br>`);
		});
	}

	get_doctype() {
		return this.doctype_select.get_value();
	}

	get_role() {
		return this.role_select.get_value();
	}

	set_empty_message(message) {
		this.body.html(`
		<div class="text-muted flex justify-center align-center" style="min-height: 300px;">
			<p class='text-muted'>
				${message}
			</p>
		</div>`);
	}

	refresh() {
		this.page.clear_secondary_action();
		this.page.clear_primary_action();

		if (!this.doctype_select) {
			return this.set_empty_message(__("Loading"));
		}

		let doctype = this.get_doctype();
		let role = this.get_role();

		if (!doctype && !role) {
			return this.set_empty_message(__("Select Document Type or Role to start."));
		}

		// get permissions
		frappe
			.call({
				module: "frappe.core",
				page: "permission_manager",
				method: "get_permissions",
				args: { doctype, role },
			})
			.then((r) => {
				this.render(r.message);
			});
	}

	render(perm_list) {
		// `perm_list` is server truth and only passed after a `refresh()`
		// round trip. Local staging (checkbox toggle, add, remove) calls
		// `render()` with no argument to redraw the same base list with
		// `this.pending_changes` overlaid - no network call.
		if (perm_list !== undefined) {
			this.perm_list = perm_list || [];
		}
		this.body.empty();
		let effective_list = this.get_effective_perm_list();
		if (!effective_list.length) {
			this.set_empty_message(__("No Permissions set for this criteria."));
		} else {
			this.show_permission_table(effective_list);
		}
		this.get_doctype() && this.make_reset_button();
		this.update_action_bar();
	}

	row_key(doctype, role, permlevel, if_owner) {
		return [doctype, role, cint(permlevel) || 0, cint(if_owner) || 0].join("::");
	}

	change_key(action, doctype, role, permlevel, if_owner, ptype) {
		let parts = [action, doctype, role, cint(permlevel) || 0, cint(if_owner) || 0];
		if (action === "update") parts.push(ptype);
		return parts.join("::");
	}

	get_base_value(doctype, role, permlevel, if_owner, ptype) {
		let row = (this.perm_list || []).find(
			(r) =>
				r.parent === doctype &&
				r.role === role &&
				this.row_key(r.parent, r.role, r.permlevel, r.if_owner) ===
					this.row_key(doctype, role, permlevel, if_owner)
		);
		return row ? row[ptype] : 0;
	}

	stage_change(change) {
		if (change.action === "update") {
			let key = this.change_key(
				"update",
				change.doctype,
				change.role,
				change.permlevel,
				change.if_owner,
				change.ptype
			);
			let is_staged_new_row = this.pending_changes.has(
				this.change_key("add", change.doctype, change.role, change.permlevel, 0)
			);
			let base_value = this.get_base_value(
				change.doctype,
				change.role,
				change.permlevel,
				change.if_owner,
				change.ptype
			);
			if (!is_staged_new_row && cint(change.value) === cint(base_value)) {
				// value toggled back to what's already on the server - nothing to stage
				this.pending_changes.delete(key);
			} else {
				this.pending_changes.set(key, change);
			}
		} else {
			// "add" / "remove" - one entry per row, last write wins
			let key = this.change_key(
				change.action,
				change.doctype,
				change.role,
				change.permlevel,
				change.if_owner
			);
			this.pending_changes.set(key, change);
		}
	}

	unstage_row(doctype, role, permlevel) {
		// drop a staged "add" and every staged "update" targeting it - used
		// when discarding a not-yet-saved row, which was never sent to the
		// server so there's nothing to "remove", only to forget.
		for (let [key, change] of Array.from(this.pending_changes)) {
			if (
				change.doctype === doctype &&
				change.role === role &&
				cint(change.permlevel) === cint(permlevel) &&
				(change.action === "add" || change.action === "update")
			) {
				this.pending_changes.delete(key);
			}
		}
	}

	purge_pending_changes_for_doctype(doctype) {
		for (let [key, change] of Array.from(this.pending_changes)) {
			if (change.doctype === doctype) this.pending_changes.delete(key);
		}
	}

	get_effective_perm_list() {
		let base = (this.perm_list || []).filter((d) => d.parent !== "DocType");
		let rows = base.map((d) => {
			let row = Object.assign({}, d);
			row.permlevel = cint(row.permlevel) || 0;
			row.if_owner = cint(row.if_owner) || 0;
			// stable row identity, captured once from server truth and never
			// touched by the overlay below - even when the field being
			// staged IS if_owner itself. Without this, toggling "Only if
			// Creator" would change the identity every subsequent checkbox
			// on the row keys off of, splitting one row's edits across two
			// different staged identities instead of collapsing onto one.
			row._base_if_owner = row.if_owner;
			return row;
		});

		if (!this.pending_changes.size) {
			return rows;
		}

		let find_row = (doctype, role, permlevel, if_owner) => {
			let key = this.row_key(doctype, role, permlevel, if_owner);
			return rows.find(
				(r) => this.row_key(r.parent, r.role, r.permlevel, r._base_if_owner) === key
			);
		};

		// 1. staged new rows, so they render (and can be edited/undone) before being applied
		this.pending_changes.forEach((change) => {
			if (change.action !== "add") return;
			if (find_row(change.doctype, change.role, change.permlevel, 0)) return;
			let meta = frappe.get_meta(change.doctype);
			rows.push({
				parent: change.doctype,
				role: change.role,
				permlevel: cint(change.permlevel) || 0,
				if_owner: 0,
				_base_if_owner: 0,
				is_submittable: meta ? meta.is_submittable : 0,
				in_create: meta ? meta.in_create : 0,
				linked_doctypes: [],
				_pending_new: true,
			});
		});

		// 2. overlay staged field values (including onto the staged-new rows above) -
		// checkboxes just show the staged value, no per-field highlight; the row-level
		// new/removed styling plus the "N Unsaved Changes" indicator carry that signal
		this.pending_changes.forEach((change) => {
			if (change.action !== "update") return;
			let row = find_row(change.doctype, change.role, change.permlevel, change.if_owner);
			if (!row) return;
			row[change.ptype] = cint(change.value);
		});

		// 3. mark rows staged for removal (row stays visible, struck through, undoable)
		this.pending_changes.forEach((change) => {
			if (change.action !== "remove") return;
			let row = find_row(change.doctype, change.role, change.permlevel, change.if_owner);
			if (row) row._pending_removal = true;
		});

		return rows;
	}

	update_action_bar() {
		let count = this.pending_changes.size;

		if (count > 0) {
			this.page.set_indicator(__("{0} Unsaved Change(s)", [count]), "orange");
			this.page.set_primary_action(
				__("Apply Changes ({0})", [count]),
				() => this.apply_pending_changes(),
				"check"
			);
			this.discard_btn && this.discard_btn.show();
		} else {
			this.page.clear_indicator();
			this.discard_btn && this.discard_btn.hide();
			this.show_add_rule();
		}
	}

	discard_pending_changes() {
		if (!this.pending_changes.size) return;
		frappe.confirm(__("Discard all unsaved permission changes?"), () => {
			this.pending_changes.clear();
			this.render();
		});
	}

	apply_pending_changes() {
		if (!this.pending_changes.size) return;

		let changes = Array.from(this.pending_changes.values()).map((c) => ({
			action: c.action,
			doctype: c.doctype,
			role: c.role,
			permlevel: cint(c.permlevel) || 0,
			if_owner: cint(c.if_owner) || 0,
			ptype: c.ptype,
			value: c.value,
		}));

		frappe.dom.freeze(__("Applying changes..."));
		frappe.call({
			module: "frappe.core",
			page: "permission_manager",
			method: "apply_changes",
			args: { changes },
			callback: (r) => {
				frappe.dom.unfreeze();
				if (r.exc) {
					// outer validation failure (bad batch shape, too many items) -
					// nothing was applied, keep everything staged so nothing is lost
					return;
				}

				let results = (r.message && r.message.results) || [];
				let failures = results.filter((res) => !res.ok);

				// server is now the source of truth for whatever it accepted -
				// including the ones that failed, since they never applied and
				// a resubmit only makes sense once the user re-stages them
				this.pending_changes.clear();

				if (failures.length) {
					let items = failures
						.map(
							(f) =>
								`<li>${frappe.utils.escape_html(
									f.error || __("Unknown error")
								)}</li>`
						)
						.join("");
					frappe.msgprint({
						title: __("Some changes could not be applied"),
						indicator: "orange",
						message: `<p>${__("{0} of {1} changes were not applied:", [
							failures.length,
							results.length,
						])}</p><ul>${items}</ul>`,
					});
				} else {
					frappe.show_alert({ message: __("Changes applied"), indicator: "green" });
				}

				this.refresh();
			},
		});
	}

	show_permission_table(perm_list) {
		this.table = $(
			"<div class='table-responsive'>\
			<table class='table table-borderless'>\
				<thead><tr></tr></thead>\
				<tbody></tbody>\
			</table>\
		</div>"
		).appendTo(this.body);

		const table_columns = [
			[__("Document Type"), 150],
			[__("Role"), 170],
			[__("Level"), 40],
			[__("Permissions"), 350],
			["", 40],
		];

		table_columns.forEach((col) => {
			$("<th>")
				.html(col[0])
				.css("width", col[1] + "px")
				.appendTo(this.table.find("thead tr"));
		});

		perm_list.forEach((d) => {
			if (!d.permlevel) d.permlevel = 0;

			let row = $("<tr>")
				.appendTo(this.table.find("tbody"))
				.toggleClass("perm-row-new", !!d._pending_new)
				.toggleClass("perm-row-removed", !!d._pending_removal);
			this.add_cell(row, d, "parent");
			let role_cell = this.add_cell(row, d, "role");

			this.set_show_users(role_cell, d.role);

			if (d.permlevel === 0) {
				// this.setup_user_permissions(d, role_cell);
				this.setup_if_owner(d, role_cell);
			}

			let cell = this.add_cell(row, d, "permlevel");

			if (d.permlevel == 0) {
				cell.css("font-weight", "bold");
			}

			let perm_cell = this.add_cell(row, d, "permissions");
			let perm_container = $("<div class='row'></div>").appendTo(perm_cell);

			this.rights.forEach((r) => {
				if (!d.is_submittable && ["submit", "cancel", "amend"].includes(r)) return;
				this.add_check(perm_container, d, r);

				if (d.if_owner && r == "report") {
					perm_container.find("div[data-fieldname='report']").toggle(false);
				}
			});

			this.options.doctype_ptype_map[d.parent]?.forEach((r) => {
				this.add_check(perm_container, d, r);
			});

			// buttons
			this.add_delete_button(row, d);
		});
	}

	add_cell(row, d, fieldname) {
		return $("<td>")
			.appendTo(row)
			.attr("data-fieldname", fieldname)
			.addClass("pt-4")
			.html(__(d[fieldname]));
	}

	add_check(cell, d, fieldname, label, description = "") {
		if (!label) label = toTitle(fieldname.replace(/_/g, " "));
		if (d.permlevel > 0 && ["read", "write", "mask"].indexOf(fieldname) == -1) {
			return;
		}

		let checkbox = $(
			`<div class='col-md-4'>
				<div class='checkbox'>
					<label><input type='checkbox'>${__(label)}</input></label>
					<p class='help-box small text-muted'>${__(description)}</p>
				</div>
			</div>`
		)
			.appendTo(cell)
			.attr("data-fieldname", fieldname);

		checkbox
			.find("input")
			.prop("checked", d[fieldname] ? true : false)
			.prop("disabled", !!d._pending_removal)
			.attr("data-ptype", fieldname)
			.attr("data-role", d.role)
			.attr("data-permlevel", d.permlevel)
			// row identity, not the live value - see `_base_if_owner` in
			// get_effective_perm_list(). Always the same for every checkbox
			// in this row, even the "if_owner" checkbox itself.
			.attr("data-if_owner", d._base_if_owner ?? d.if_owner)
			.attr("data-doctype", d.parent);

		checkbox.find("label").css("text-transform", "capitalize");
		checkbox.find("label").css("align-items", "center");

		return checkbox;
	}

	setup_if_owner(d, role_cell) {
		this.add_check(role_cell, d, "if_owner", "Only if Creator")
			.removeClass("col-md-4")
			.css({ "margin-top": "15px" });
	}

	get rights() {
		return [
			"select",
			"read",
			"write",
			"create",
			"delete",
			"submit",
			"cancel",
			"amend",
			"print",
			"email",
			"report",
			"import",
			"export",
			"share",
			"mask",
		];
	}

	set_show_users(cell, role) {
		cell.html("<a class='grey' href='#'>" + __(role) + "</a>")
			.find("a")
			.attr("data-role", role)
			.click(function () {
				const role = $(this).attr("data-role");
				frappe.call({
					module: "frappe.core",
					page: "permission_manager",
					method: "get_users_with_role",
					args: { role },
					callback: function (r) {
						let message_html = "";

						const role_label = __(role);
						const users = (r.message || []).filter(Boolean);
						const user_count = users.length;
						const display_count = Math.min(user_count, 5);

						if (user_count === 0) {
							message_html = __("No user has the role <strong>{0}</strong>", [
								role_label,
							]);
						} else {
							const user_text = user_count === 1 ? __("User") : __("Users");
							const display_users = users.slice(0, display_count);

							const user_list = display_users
								.map(
									(user) =>
										`<li class="py-1">
                        					${frappe.utils.get_form_link("User", user, true)}
                    					</li>`
								)
								.join("");

							message_html = __("{0} with the role <strong>{1}</strong>", [
								user_text,
								role_label,
							]);

							message_html += `<ul class="border rounded pl-4 pb-2 pt-2 mb-3 mt-3">${user_list}</ul>`;

							// show compact "View All" link if more users
							if (user_count > display_count) {
								const route = frappe.utils.generate_route({
									type: "Doctype",
									doctype: "User",
									name: "User",
									doc_view: "List",
									route_options: { role },
								});

								message_html += `<div class="text-center">
                    								<a href="${route}" class="text-muted">
														${frappe.utils.icon("external-link", "sm", "mr-1")}
														${__("View all {0} users", [user_count])}
                    								</a>
                								</div>`;
							}
						}

						frappe.msgprint({
							title: __("Users"),
							message: message_html,
							indicator: user_count === 0 ? "orange" : "blue",
						});
					},
				});
				return false;
			});
	}

	add_delete_button(row, d) {
		let $td = $(`<td class="pt-4">`).appendTo(row);

		if (d._pending_new) {
			// never sent to the server - discarding just forgets it
			frappe.ui
				.button({
					icon: "x",
					variant: "solid",
					theme: "red",
					size: "xs",
					tooltip: __("Discard"),
					onclick: () => {
						this.unstage_row(d.parent, d.role, d.permlevel);
						this.render();
					},
				})
				.appendTo($td);
			return;
		}

		if (d._pending_removal) {
			frappe.ui
				.button({
					label: __("Undo"),
					variant: "outline",
					size: "xs",
					onclick: () => {
						this.pending_changes.delete(
							this.change_key(
								"remove",
								d.parent,
								d.role,
								d.permlevel,
								d._base_if_owner
							)
						);
						this.render();
					},
				})
				.appendTo($td);
			return;
		}

		frappe.ui
			.button({
				icon: "x",
				variant: "solid",
				theme: "red",
				size: "xs",
				tooltip: __("Remove"),
				onclick: () => {
					this.stage_change({
						action: "remove",
						doctype: d.parent,
						role: d.role,
						permlevel: d.permlevel,
						if_owner: d._base_if_owner,
					});
					this.render();
				},
			})
			.appendTo($td);
	}

	add_check_events() {
		let me = this;
		this.body.on("click", ".show-user-permissions", () => {
			frappe.route_options = { allow: this.get_doctype() || "" };
			frappe.set_route("List", "User Permission");
		});

		this.body.on("click", "input[type='checkbox']", function () {
			let chk = $(this);
			if (chk.prop("disabled")) return false;

			me.stage_change({
				action: "update",
				role: chk.attr("data-role"),
				permlevel: chk.attr("data-permlevel"),
				doctype: chk.attr("data-doctype"),
				ptype: chk.attr("data-ptype"),
				value: chk.prop("checked") ? 1 : 0,
				if_owner: chk.attr("data-if_owner"),
			});
			// full local re-render: for the if_owner checkbox specifically, this
			// also picks up the report-checkbox show/hide that already lives in
			// show_permission_table().
			me.render();
		});
	}

	show_add_rule() {
		this.page.set_primary_action(
			__("Add A New Rule"),
			() => {
				let d = new frappe.ui.Dialog({
					title: __("Add New Permission Rule"),
					fields: [
						{
							fieldtype: "Select",
							label: __("Document Type"),
							options: this.options.doctypes,
							reqd: 1,
							fieldname: "parent",
						},
						{
							fieldtype: "Select",
							label: __("Role"),
							options: this.options.roles,
							reqd: 1,
							fieldname: "role",
						},
						{
							fieldtype: "Select",
							label: __("Permission Level"),
							options: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
							reqd: 1,
							fieldname: "permlevel",
							description: __(
								"Level 0 is for document level permissions, higher levels for field level permissions."
							),
						},
					],
				});
				if (this.get_doctype()) {
					d.set_value("parent", this.get_doctype());
					d.get_input("parent").prop("disabled", true);
				}
				if (this.get_role()) {
					d.set_value("role", this.get_role());
					d.get_input("role").prop("disabled", true);
				}
				d.set_value("permlevel", "0");
				d.set_primary_action(__("Add"), () => {
					let args = d.get_values();
					if (!args) {
						return;
					}

					let doctype = args.parent;
					let role = args.role;
					let permlevel = cint(args.permlevel);
					let key = this.row_key(doctype, role, permlevel, 0);
					let already_exists = (this.perm_list || []).some(
						(r) => this.row_key(r.parent, r.role, r.permlevel, r.if_owner) === key
					);
					if (already_exists) {
						frappe.msgprint(
							__("A rule for this Document Type, Role and Level already exists.")
						);
						return;
					}

					this.stage_change({ action: "add", doctype, role, permlevel });
					this.render();
					d.hide();
				});
				d.show();
			},
			"plus"
		);
	}

	make_reset_button() {
		this.page.set_secondary_action(__("Restore Original Permissions"), () => {
			this.get_standard_permissions((data) => {
				this.reset_std_permissions(data);
			});
		});
	}

	get_link_fields(doctype) {
		return frappe.get_children("DocType", doctype, "fields", {
			fieldtype: "Link",
			options: ["not in", ["User", "[Select]"]],
		});
	}

	show_activity_log() {
		const PERM_FIELDS = [
			"select",
			"read",
			"write",
			"create",
			"delete",
			"submit",
			"cancel",
			"amend",
			"print",
			"email",
			"report",
			"import",
			"export",
			"share",
			"mask",
		];
		const STATUS_COLOR = { Added: "green", Removed: "red", Updated: "amber", Reset: "blue" };

		let doctype = this.get_doctype();
		let show_doctype_column = !doctype;

		let title = doctype
			? __("Activity Log for {0}", [__(doctype)])
			: __("Role Permissions Activity Log");

		let d = new frappe.ui.Dialog({ title, size: "large" });
		let $body = $(d.body);
		$body.html(`<div class="text-muted text-center p-4">${__("Loading\u2026")}</div>`);

		frappe
			.call({
				module: "frappe.core",
				page: "permission_manager",
				method: "get_permission_logs",
				args: { doctype: doctype || null, limit: 50 },
			})
			.then((r) => {
				let logs = r.message || [];
				$body.empty();

				if (!logs.length) {
					$body.html(
						`<div class="text-muted text-center p-4">${__(
							"No activity recorded yet."
						)}</div>`
					);
					return;
				}

				let rows = logs
					.map((log) => {
						let ch = log.changes || {};
						let from = ch.from || {};
						let to = ch.to || {};

						// Role: prefer the side that has data
						let role =
							(log.status === "Removed" ? from.role : to.role) || from.role || "—";

						// Active permissions: for Added/Removed show the full set;
						// for Updated show only what flipped; for Reset show summary
						let changes_text = "";
						if (log.status === "Reset") {
							changes_text = __("Restored to standard permissions");
						} else if (log.status === "Updated") {
							let parts = [];
							PERM_FIELDS.forEach((f) => {
								if (f in to && to[f] !== from[f]) {
									let label = toTitle(frappe.unscrub(f));
									parts.push(
										to[f]
											? `<span class="diff-add">${__(label)}</span>`
											: `<span class="diff-remove">${__(label)}</span>`
									);
								}
							});
							changes_text = parts.join(", ") || "—";
						} else {
							// Added or Removed — list the active permission types
							let source = log.status === "Removed" ? from : to;
							let active = PERM_FIELDS.filter(
								(f) => source[f] == 1 || source[f] === true
							);
							changes_text =
								active.map((f) => __(toTitle(frappe.unscrub(f)))).join(", ") ||
								"—";
						}

						let badge_color = STATUS_COLOR[log.status] || "gray";
						let ts = frappe.datetime.comment_when(log.changed_at);
						let user_display = log.changed_by || "—";

						let doctype_cell =
							show_doctype_column && log.for_document
								? `<td>${frappe.utils.get_form_link(
										"DocType",
										log.for_document,
										true
								  )}</td>`
								: "";

						return `<tr>
							<td>${user_display}</td>
							<td>${frappe.ui.badge.html({ label: __(log.status), theme: badge_color })}</td>
							<td>${__(role)}</td>
							${doctype_cell}
							<td class="small">${changes_text}</td>
							<td class="frappe-timestamp-cell">${ts}</td>
						</tr>`;
					})
					.join("");

				let header_doctype = show_doctype_column
					? `<th style="min-width:120px">${__("DocType")}</th>`
					: "";

				$body.html(`
					<div style="overflow-x: auto;">
						<table class="table table-bordered table-sm" style="font-size:13px">
							<thead style="background:var(--fg-color)">
								<tr>
									<th style="min-width:110px">${__("Modified By")}</th>
									<th style="min-width:90px">${__("Action")}</th>
									<th style="min-width:110px">${__("Role")}</th>
									${header_doctype}
									<th>${__("Changes")}</th>
									<th style="min-width:100px">${__("Timestamp")}</th>
								</tr>
							</thead>
							<tbody>${rows}</tbody>
						</table>
					</div>
					<div class="text-right mt-2">
						<button class="btn btn-sm btn-default btn-view-full-log">
							${frappe.utils.icon("external-link", "sm", "mr-1")}
							${__("View full log")}
						</button>
					</div>
				`);

				$body.find(".btn-view-full-log").on("click", () => {
					d.hide();
					frappe.route_options = { for_doctype: "DocType" };
					if (doctype) {
						frappe.route_options.for_document = doctype;
					}
					frappe.set_route("List", "Permission Log");
				});
			});

		d.show();
	}
};
