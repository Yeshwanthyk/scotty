use gpui::{
    App, Bounds, Context, FocusHandle, Focusable, IntoElement, Render, Role, SharedString,
    Subscription, TitlebarOptions, Window, WindowBounds, WindowControlArea, WindowOptions, div,
    prelude::*, px, rems, size,
};

use crate::preferences::{
    self, AppearancePreference, DensityPreference, MonoFontPreference, UiFontPreference,
};
use crate::theme::Theme;

pub fn open(cx: &mut App) {
    if let Some(handle) = cx
        .windows()
        .into_iter()
        .find_map(|window| window.downcast::<SettingsView>())
    {
        handle
            .update(cx, |_, window, _| window.activate_window())
            .ok();
        return;
    }

    cx.defer(|cx| {
        let bounds = Bounds::centered(None, size(px(680.0), px(590.0)), cx);
        if let Err(error) = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(560.0), px(520.0))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Scotty Settings".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(gpui::point(px(14.0), px(14.0))),
                }),
                app_owns_titlebar_drag: true,
                window_background: gpui::WindowBackgroundAppearance::Opaque,
                app_id: Some("scotty-desktop".into()),
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| SettingsView::new(window, cx));
                window.focus(&view.read(cx).focus_handle(cx), cx);
                view
            },
        ) {
            tracing::error!(%error, "failed to open Scotty settings window");
        }
        cx.activate(true);
    });
}

#[derive(Clone, Copy)]
enum SizeSetting {
    Interface,
    Composer,
    Code,
}

struct SettingsView {
    focus: FocusHandle,
    _appearance_subscription: Subscription,
}

impl SettingsView {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let appearance_subscription =
            cx.observe_window_appearance(window, |_, _, cx| preferences::apply_theme(cx));
        Self {
            focus: cx.focus_handle(),
            _appearance_subscription: appearance_subscription,
        }
    }

    fn choice(
        &self,
        id: SharedString,
        label: &'static str,
        selected: bool,
        on_click: impl Fn(&mut App) + 'static,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .id(id)
            .role(Role::Button)
            .aria_label(label)
            .aria_selected(selected)
            .focusable()
            .tab_stop(true)
            .h(px(30.0))
            .px(px(11.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(7.0))
            .border_1()
            .border_color(if selected {
                theme.accent.opacity(0.5)
            } else {
                theme.border
            })
            .bg(if selected {
                theme.accent.opacity(0.14)
            } else {
                theme.surface
            })
            .text_color(if selected {
                theme.text
            } else {
                theme.text_muted
            })
            .hover(|button| button.bg(theme.element_hover))
            .cursor_pointer()
            .on_click(cx.listener(move |_, _, _, cx| on_click(cx)))
            .child(label)
            .into_any_element()
    }

    fn setting_row(
        &self,
        title: &'static str,
        description: &'static str,
        control: impl IntoElement,
        theme: &Theme,
    ) -> gpui::AnyElement {
        div()
            .w_full()
            .min_h(px(68.0))
            .py(theme.space(12.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(24.0))
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex_1()
                    .child(
                        div()
                            .text_size(rems(13.0 / 16.0))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(title),
                    )
                    .child(
                        div()
                            .mt(px(3.0))
                            .text_size(rems(11.0 / 16.0))
                            .text_color(theme.text_faint)
                            .child(description),
                    ),
            )
            .child(control)
            .into_any_element()
    }

    fn render_appearance(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let current = preferences::get(cx).appearance;
        let controls =
            div()
                .flex()
                .gap(px(6.0))
                .children(AppearancePreference::ALL.into_iter().map(|preference| {
                    self.choice(
                        SharedString::from(format!("appearance-{}", preference.label())),
                        preference.label(),
                        current == preference,
                        move |cx| preferences::update(cx, |values| values.appearance = preference),
                        theme,
                        cx,
                    )
                }));
        self.setting_row(
            "Appearance",
            "Follow macOS or keep Scotty dark.",
            controls,
            theme,
        )
    }

    fn render_ui_font(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let current = preferences::get(cx).ui_font;
        let controls = div()
            .flex()
            .gap(px(6.0))
            .children(UiFontPreference::ALL.into_iter().map(|preference| {
                self.choice(
                    SharedString::from(format!("ui-font-{}", preference.label())),
                    preference.label(),
                    current == preference,
                    move |cx| preferences::update(cx, |values| values.ui_font = preference),
                    theme,
                    cx,
                )
            }));
        self.setting_row(
            "Interface font",
            "Use bundled Geist or the native system UI font.",
            controls,
            theme,
        )
    }

    fn render_mono_font(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let current = preferences::get(cx).mono_font;
        let controls = div()
            .flex()
            .gap(px(6.0))
            .children(MonoFontPreference::ALL.into_iter().map(|preference| {
                self.choice(
                    SharedString::from(format!("mono-font-{}", preference.label())),
                    preference.label(),
                    current == preference,
                    move |cx| preferences::update(cx, |values| values.mono_font = preference),
                    theme,
                    cx,
                )
            }));
        self.setting_row(
            "Code font",
            "Used for tool output, code, IDs, and technical details.",
            controls,
            theme,
        )
    }

    fn render_density(&self, theme: &Theme, cx: &mut Context<Self>) -> gpui::AnyElement {
        let current = preferences::get(cx).density;
        let controls = div()
            .flex()
            .gap(px(6.0))
            .children(DensityPreference::ALL.into_iter().map(|preference| {
                self.choice(
                    SharedString::from(format!("density-{}", preference.label())),
                    preference.label(),
                    current == preference,
                    move |cx| preferences::update(cx, |values| values.density = preference),
                    theme,
                    cx,
                )
            }));
        self.setting_row(
            "Interface density",
            "Adjust high-traffic spacing without shrinking text.",
            controls,
            theme,
        )
    }

    fn render_size(
        &self,
        title: &'static str,
        description: &'static str,
        setting: SizeSetting,
        value: f32,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let decrement = div()
            .id(SharedString::from(format!("decrease-{title}")))
            .role(Role::Button)
            .aria_label(SharedString::from(format!("Decrease {title}")))
            .focusable()
            .tab_stop(true)
            .size(px(30.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded_l(px(7.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface)
            .hover(|button| button.bg(theme.element_hover))
            .cursor_pointer()
            .on_click(cx.listener(move |_, _, _, cx| change_size(cx, setting, -0.5)))
            .child("−");
        let increment = div()
            .id(SharedString::from(format!("increase-{title}")))
            .role(Role::Button)
            .aria_label(SharedString::from(format!("Increase {title}")))
            .focusable()
            .tab_stop(true)
            .size(px(30.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded_r(px(7.0))
            .border_1()
            .border_color(theme.border)
            .bg(theme.surface)
            .hover(|button| button.bg(theme.element_hover))
            .cursor_pointer()
            .on_click(cx.listener(move |_, _, _, cx| change_size(cx, setting, 0.5)))
            .child("+");
        let control = div()
            .flex()
            .items_center()
            .child(decrement)
            .child(
                div()
                    .w(px(58.0))
                    .h(px(30.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_y_1()
                    .border_color(theme.border)
                    .bg(theme.surface_raised)
                    .font_family(theme.font_mono.clone())
                    .text_size(px(11.0))
                    .child(SharedString::from(format!("{value:.1}"))),
            )
            .child(increment);
        self.setting_row(title, description, control, theme)
    }
}

fn change_size(cx: &mut App, setting: SizeSetting, amount: f32) {
    preferences::update(cx, |values| match setting {
        SizeSetting::Interface => values.ui_text_size += amount,
        SizeSetting::Composer => values.composer_text_size += amount,
        SizeSetting::Code => values.mono_text_size += amount,
    });
}

impl Focusable for SettingsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(cx).clone();
        let values = preferences::get(cx).clone();
        window.set_rem_size(px(theme.rem_size()));

        div()
            .id("settings-root")
            .role(Role::Application)
            .aria_label("Scotty Settings")
            .track_focus(&self.focus)
            .size_full()
            .bg(theme.bg)
            .text_color(theme.text)
            .font_family(theme.font_sans.clone())
            .child(
                div()
                    .window_control_area(WindowControlArea::Drag)
                    .h(px(54.0))
                    .w_full()
                    .border_b_1()
                    .border_color(theme.border)
                    .flex()
                    .items_center()
                    .px(px(24.0))
                    .when(cfg!(target_os = "macos"), |header| header.pl(px(72.0)))
                    .text_size(rems(14.0 / 16.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child("Settings"),
            )
            .child(
                div()
                    .px(px(28.0))
                    .pt(px(16.0))
                    .child(self.render_appearance(&theme, cx))
                    .child(self.render_ui_font(&theme, cx))
                    .child(self.render_mono_font(&theme, cx))
                    .child(self.render_size(
                        "Interface text",
                        "Scales labels and primary interface text.",
                        SizeSetting::Interface,
                        values.ui_text_size,
                        &theme,
                        cx,
                    ))
                    .child(self.render_size(
                        "Composer text",
                        "Changes the editable prompt text independently.",
                        SizeSetting::Composer,
                        values.composer_text_size,
                        &theme,
                        cx,
                    ))
                    .child(self.render_size(
                        "Code text",
                        "Changes monospaced output without resizing the interface.",
                        SizeSetting::Code,
                        values.mono_text_size,
                        &theme,
                        cx,
                    ))
                    .child(self.render_density(&theme, cx))
                    .child(
                        div()
                            .pt(px(12.0))
                            .text_size(rems(10.0 / 16.0))
                            .text_color(theme.text_faint)
                            .child("Changes are saved automatically."),
                    ),
            )
    }
}
