frappe.provide("frappe.ui.whats_new");

const MODE_SWITCH_COOLDOWN_MS = 600;
const GESTURE_DOMINANCE = 1.5;
const TOUCH_SLOP_PX = 10;

const prefers_reduced_motion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

frappe.ui.whats_new.show = async function () {
	const releases = await frappe.xcall("frappe.utils.change_log.get_whats_new", undefined, "GET");
	const release = releases?.[0];
	if (!release?.features?.length) return;
	new WhatsNew(release).show();
};

class WhatsNew {
	constructor(release) {
		this.release = release;
		this.features = release.features;
		this.index = 0;
		this.mode = "cards";
		this.mode_changed_at = 0;
	}

	show() {
		this.dialog = new frappe.ui.Dialog({ size: "large" });
		this.dialog.$wrapper.addClass("whats-new-dialog");
		this.dialog.$body.html(this.html());
		this.modal = this.dialog.$wrapper.get(0);
		this.track = this.dialog.$body.find(".whats-new-track").get(0);
		this.$cards = this.dialog.$body.find(".whats-new-card");
		this.$dots = this.dialog.$body.find(".whats-new-dot");
		this.bind();
		this.dialog.show();
		this.set_active(0);
	}

	html() {
		const theme = frappe.ui.get_current_theme() === "dark" ? "dark" : "light";
		const meta = `v${this.release.version} · ${moment(this.release.date).format(
			"D MMM YYYY"
		)}`;
		const cards = this.features
			.map(
				(feature) => `
				<article class="whats-new-card">
					${this.media_html(feature, theme)}
					<h3 class="whats-new-title">${frappe.utils.escape_html(feature.title)}</h3>
					<p class="whats-new-description">${frappe.utils.escape_html(feature.description)}</p>
				</article>`
			)
			.join("");
		const dots = this.features
			.map(
				(feature, i) => `
				<button type="button" class="whats-new-dot" data-index="${i}"
					aria-label="${frappe.utils.escape_html(feature.title)}"></button>`
			)
			.join("");
		return `
			<header class="whats-new-header">
				<h2 class="whats-new-heading-title">${__("What's New")}</h2>
				<div class="whats-new-meta">${frappe.utils.escape_html(meta)}</div>
			</header>
			<div class="whats-new-viewport">
				<div class="whats-new-track">${cards}</div>
				<div class="whats-new-nav">
					${this.nav_button_html("prev", "chevron-left", __("Previous"))}
					${this.nav_button_html("next", "chevron-right", __("Next"))}
				</div>
			</div>
			<div class="whats-new-footer">
				<div class="whats-new-dots">${dots}</div>
				${frappe.ui.button.html({ label: __("Done"), variant: "solid", css_class: "whats-new-done" })}
			</div>`;
	}

	nav_button_html(direction, icon, label) {
		return `<button type="button" class="whats-new-nav-button" data-direction="${direction}"
			aria-label="${label}">${frappe.utils.icon(icon, "sm")}</button>`;
	}

	media_html(feature, theme) {
		const src = feature.video?.[theme] || feature.video?.light;
		if (src) {
			return `<video class="whats-new-media" src="${frappe.utils.escape_html(src)}"
				muted loop playsinline preload="metadata"
				aria-label="${frappe.utils.escape_html(feature.title)}"></video>`;
		}
		return `<div class="whats-new-media whats-new-placeholder">
			${frappe.utils.icon("play", "lg")}
			<span>${__("Video coming soon")}</span>
		</div>`;
	}

	bind() {
		const $body = this.dialog.$body;
		$body.on("click", ".whats-new-dot", (e) => this.go_to(+e.currentTarget.dataset.index));
		$body.on("click", ".whats-new-nav-button", (e) =>
			this.go_to(this.index + (e.currentTarget.dataset.direction === "next" ? 1 : -1))
		);
		$body.on("click", ".whats-new-done", () => this.dialog.hide());

		this.track.addEventListener("scroll", () => this.sync_to_scroll(), { passive: true });
		this.modal.addEventListener("scroll", () => this.sync_to_scroll(), { passive: true });
		this.modal.addEventListener("wheel", (e) => this.on_wheel(e), { passive: false });
		this.modal.addEventListener("touchstart", (e) => this.on_touch_start(e), {
			passive: true,
		});
		this.modal.addEventListener("touchmove", (e) => this.on_touch_move(e), { passive: false });

		this.dialog.$wrapper.on("keydown", (e) => {
			const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
			if (step && this.mode === "list") this.set_mode("cards");
			else if (step) this.go_to(this.index + step);
			if (["ArrowDown", "ArrowUp"].includes(e.key)) this.set_mode("list");
		});
		this.dialog.$wrapper.on("shown.bs.modal", () => this.play_active());
		this.dialog.onhide = () => this.$cards.find("video").each((_, video) => video.pause());
		this.dialog.$wrapper.one("hidden.bs.modal", () => this.dialog.$wrapper.remove());
	}

	go_to(index) {
		if (index < 0 || index >= this.features.length) return;
		const behavior = prefers_reduced_motion() ? "auto" : "smooth";
		if (this.mode === "list") {
			this.$cards.get(index).scrollIntoView({ behavior, block: "start" });
		} else {
			this.track.scrollTo({ left: index * this.track.clientWidth, behavior });
		}
	}

	sync_to_scroll() {
		const index =
			this.mode === "list"
				? this.index_in_list()
				: Math.round(this.track.scrollLeft / this.track.clientWidth);
		if (index !== this.index) this.set_active(index);
	}

	index_in_list() {
		const { scrollTop, clientHeight, scrollHeight } = this.modal;
		if (scrollTop + clientHeight >= scrollHeight - 1) return this.features.length - 1;
		const reading_line = clientHeight / 3;
		let index = 0;
		this.$cards.each((i, card) => {
			if (card.getBoundingClientRect().top <= reading_line) index = i;
		});
		return index;
	}

	on_wheel(e) {
		this.switch_on_gesture(e, Math.abs(e.deltaX), Math.abs(e.deltaY));
	}

	on_touch_start(e) {
		const touch = e.touches[0];
		this.touch_origin = { x: touch.clientX, y: touch.clientY };
	}

	on_touch_move(e) {
		if (!this.touch_origin) return;
		const touch = e.touches[0];
		const dx = Math.abs(touch.clientX - this.touch_origin.x);
		const dy = Math.abs(touch.clientY - this.touch_origin.y);
		if (Math.max(dx, dy) < TOUCH_SLOP_PX) return;
		this.touch_origin = null;
		this.switch_on_gesture(e, dx, dy);
	}

	// Vertical gestures open the list; sideways gestures return to cards.
	switch_on_gesture(e, dx, dy) {
		const wants_list = this.mode === "cards" && dy > dx * GESTURE_DOMINANCE;
		const wants_cards = this.mode === "list" && dx > dy * GESTURE_DOMINANCE;
		if (!wants_list && !wants_cards) return;
		e.preventDefault();
		this.set_mode(wants_list ? "list" : "cards");
	}

	set_mode(mode) {
		const now = Date.now();
		if (mode === this.mode || now - this.mode_changed_at < MODE_SWITCH_COOLDOWN_MS) return;
		this.mode_changed_at = now;

		const index = this.index;
		const $active = this.$cards.eq(index);
		const update = () => {
			this.mode = mode;
			this.dialog.$wrapper.toggleClass("whats-new-list", mode === "list");
			this.track.scrollLeft = mode === "list" ? 0 : index * this.track.clientWidth;
			if (mode === "list" && index > 0) $active.get(0).scrollIntoView({ block: "start" });
			else this.modal.scrollTop = 0;
			this.set_active(index);
		};

		if (!document.startViewTransition || prefers_reduced_motion()) return update();
		this.dialog.$wrapper.addClass("whats-new-morphing");
		$active.addClass("whats-new-morph-source");
		document.startViewTransition(update).finished.finally(() => {
			this.dialog.$wrapper.removeClass("whats-new-morphing");
			$active.removeClass("whats-new-morph-source");
		});
	}

	set_active(index) {
		this.index = index;
		this.$cards.each((i, card) => {
			card.classList.toggle("active", i === index);
			card.inert = this.mode === "cards" && i !== index;
		});
		this.$dots.each((i, dot) => {
			dot.classList.toggle("active", i === index);
			dot.setAttribute("aria-current", i === index ? "step" : "false");
		});
		const $body = this.dialog.$body;
		$body.find('[data-direction="prev"]').toggleClass("invisible", index === 0);
		$body.find('[data-direction="next"]').toggleClass("invisible", this.is_last());
		$body.find(".whats-new-done").toggleClass("invisible", !this.is_last());
		this.play_active();
	}

	play_active() {
		this.$cards.each((i, card) => {
			const video = card.querySelector("video");
			if (!video) return;
			if (i === this.index && this.dialog.display) {
				video.currentTime = 0;
				video.play().catch(() => {});
			} else {
				video.pause();
			}
		});
	}

	is_last() {
		return this.index === this.features.length - 1;
	}
}
