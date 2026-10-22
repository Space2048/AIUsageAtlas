// AIUsageAtlas 悬浮球 — Rust 侧只做窗口/托盘/生命周期，不碰数据。
// 所有业务动作（同步、打开仪表盘、面板显隐）都广播给前端 JS 处理，
// 服务器地址等配置也只存在前端 localStorage 里，Rust 保持无状态。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 诊断通道：前端把关键事件打到 dev 控制台（生产无副作用，仅多一行 stderr）
#[tauri::command]
fn diag(msg: String) {
    eprintln!("[js] {msg}");
}

/// Win11 会给无边框窗口合成 DWM 方形阴影（shadow:false 配置与运行时 set_shadow 都压不住），
/// 直接关掉窗口的非客户区渲染并取消圆角（球体是圆的，不需要窗口圆角）。
#[cfg(windows)]
fn kill_dwm_shadow(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(w) = handle.as_raw() else { return };
    let hwnd = w.hwnd.get() as *mut std::ffi::c_void;
    unsafe {
        // 只取消圆角即可去 Win11 阴影（阴影随圆角非客户区而来）。
        // 不要设 DWMWA_NCRENDERING_POLICY=DISABLED——会让系统回退传统方式画出可见标题栏。
        let corner = DWMWCP_DONOTROUND as i32;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corner as *const _ as *const _,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn kill_dwm_shadow(_window: &tauri::WebviewWindow) {}

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：二次启动时把已有悬浮球带回前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(ball) = app.get_webview_window("ball") {
                let _ = ball.show();
                let _ = ball.unminimize();
                let _ = ball.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))        .invoke_handler(tauri::generate_handler![diag])
        .setup(|app| {
            // Windows DefWindowProc 会把窗口钳到 SM_CXMINTRACK（本机 136px），
            // 创建期的 minWidth 配置压不住；tao 的 size constraints 可以——运行时重设。
            // 注意：绝不要在这里调 set_shadow(false)——tao 会借机重新应用窗口样式，
            // 把配置里的 decorations:false 丢掉，球窗口变回带标题栏的默认窗。
            // 无边框 = 配置 decorations:false；无 DWM 方形阴影 = kill_dwm_shadow()。
            if let Some(ball) = app.get_webview_window("ball") {
                use tauri::LogicalSize;
                let _ = ball.set_min_size(Some(LogicalSize::new(104.0, 104.0)));
                let _ = ball.set_size(LogicalSize::new(104.0, 104.0));
                kill_dwm_shadow(&ball);
                let _ = ball.set_decorations(false);
            }
            if let Some(panel) = app.get_webview_window("panel") {
                kill_dwm_shadow(&panel);
                let _ = panel.set_decorations(false);
            }

            let dashboard = MenuItem::with_id(app, "dashboard", "打开仪表盘", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "立即同步", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&dashboard, &refresh, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .expect("缺少应用图标：请先运行 `npx tauri icon` 生成 icons/")
                        .clone(),
                )
                .tooltip("AIUsageAtlas")
                .menu(&menu)
                // 左键点击不弹菜单，走 toggle-panel 事件；右键才弹菜单
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "dashboard" => {
                        let _ = app.emit("tray-action", "dashboard");
                    }
                    "refresh" => {
                        let _ = app.emit("tray-action", "refresh");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = tray.app_handle().emit("tray-action", "toggle-panel");
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
