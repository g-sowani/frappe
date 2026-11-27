frappe.provide("frappe.ui.whats_new");

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
	}

	show() {
		this.dialog = new frappe.ui.Dialog({ size: "large" });
		this.dialog.$wrapper.addClass("whats-new-dialog");
		this.dialog.$body.html(this.html());
		this.$cards = this.dialog.$body.find(".whats-new-card");
		this.$dots = this.dialog.$body.find(".whats-new-dot");
		this.bind();
		this.dialog.show();
		this.go_to(0);
	}

	html() {
		const theme = frappe.ui.get_current_theme() === "dark" ? "dark" : "light";
		const eyebrow = __("What's New in v{0}", [this.release.version]);
		const cards = this.features
			.map(
				(feature, i) => `
				<article class="whats-new-card" data-index="${i}">
					${this.media_html(feature, theme)}
					<div class="whats-new-eyebrow">${frappe.utils.escape_html(eyebrow)}</div>
					<h2 class="whats-new-title">${frappe.utils.escape_html(feature.title)}</h2>
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
			<div class="whats-new-cards">${cards}</div>
			<div class="whats-new-footer">
				<div class="whats-new-dots">${dots}</div>
				<div class="whats-new-actions">
					${frappe.ui.button.html({ label: __("Skip"), variant: "ghost", css_class: "whats-new-skip" })}
					${frappe.ui.button.html({ label: __("Back"), variant: "subtle", css_class: "whats-new-back" })}
					${frappe.ui.button.html({ label: __("Next"), variant: "solid", css_class: "whats-new-next" })}
				</div>
			</div>`;
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
		$body.on("click", ".whats-new-next", () => {
			if (this.is_last()) this.dialog.hide();
			else this.go_to(this.index + 1);
		});
		$body.on("click", ".whats-new-back", () => this.go_to(this.index - 1));
		$body.on("click", ".whats-new-skip", () => this.dialog.hide());
		$body.on("click", ".whats-new-dot", (e) => this.go_to(+e.currentTarget.dataset.index));

		this.dialog.$wrapper.on("keydown", (e) => {
			if (e.key === "ArrowRight" && !this.is_last()) this.go_to(this.index + 1);
			if (e.key === "ArrowLeft") this.go_to(this.index - 1);
		});
		this.dialog.$wrapper.on("shown.bs.modal", () => this.play_active());
		this.dialog.onhide = () => this.$cards.find("video").each((_, video) => video.pause());
		this.dialog.$wrapper.one("hidden.bs.modal", () => this.dialog.$wrapper.remove());
	}

	go_to(index) {
		if (index < 0 || index >= this.features.length) return;
		this.index = index;

		this.$cards.each((i, card) => {
			const active = i === index;
			card.classList.toggle("active", active);
			card.dataset.from = i < index ? "back" : "forward";
			card.inert = !active;
		});
		this.play_active();
		this.$dots.each((i, dot) => {
			dot.classList.toggle("active", i === index);
			dot.setAttribute("aria-current", i === index ? "step" : "false");
		});

		const $footer = this.dialog.$body.find(".whats-new-footer");
		$footer.find(".whats-new-back").toggleClass("hide", index === 0);
		$footer.find(".whats-new-skip").toggleClass("hide", this.is_last());
		$footer
			.find(".whats-new-next .es-button__label")
			.text(this.is_last() ? __("Done") : __("Next"));
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
