frappe.provide("frappe.ui.whats_new");

const WHEEL_STEP_GAP_MS = 450;

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
		this.last_wheel_step = 0;
	}

	show() {
		this.dialog = new frappe.ui.Dialog({ size: "large" });
		this.dialog.$wrapper.addClass("whats-new-dialog");
		this.dialog.$body.html(this.html());
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
		this.track.addEventListener("wheel", (e) => this.step_on_wheel(e), { passive: false });

		this.dialog.$wrapper.on("keydown", (e) => {
			if (e.key === "ArrowRight") this.go_to(this.index + 1);
			if (e.key === "ArrowLeft") this.go_to(this.index - 1);
		});
		this.dialog.$wrapper.on("shown.bs.modal", () => this.play_active());
		this.dialog.onhide = () => this.$cards.find("video").each((_, video) => video.pause());
		this.dialog.$wrapper.one("hidden.bs.modal", () => this.dialog.$wrapper.remove());
	}

	go_to(index) {
		if (index < 0 || index >= this.features.length) return;
		const reduce_motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		this.track.scrollTo({
			left: index * this.track.clientWidth,
			behavior: reduce_motion ? "auto" : "smooth",
		});
	}

	sync_to_scroll() {
		const index = Math.round(this.track.scrollLeft / this.track.clientWidth);
		if (index !== this.index) this.set_active(index);
	}

	// A mouse wheel only scrolls vertically, so each notch steps one card.
	step_on_wheel(e) {
		if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
		e.preventDefault();
		const now = Date.now();
		if (now - this.last_wheel_step < WHEEL_STEP_GAP_MS) return;
		this.last_wheel_step = now;
		this.go_to(this.index + Math.sign(e.deltaY));
	}

	set_active(index) {
		this.index = index;
		this.$cards.each((i, card) => {
			card.classList.toggle("active", i === index);
			card.inert = i !== index;
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
