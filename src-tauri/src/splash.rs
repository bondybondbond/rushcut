#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicUsize, Ordering};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect,
    SelectObject, SetBkMode, SetTextColor, TextOutW, PAINTSTRUCT, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetSystemMetrics, GetWindowLongPtrW, KillTimer, PostMessageW, PostQuitMessage,
    RegisterClassExW, SetTimer, SetWindowLongPtrW, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW,
    GWLP_USERDATA, MSG, SM_CXSCREEN, SM_CYSCREEN, WM_CLOSE, WM_CREATE,
    WM_DESTROY, WM_PAINT, WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

const SPLASH_W: i32 = 400;
const SPLASH_H: i32 = 180;
const TIMER_ID: usize = 1;
const TIMER_MS: u32 = 50;

// Background  #0a0a0a = RGB(10, 10, 10)
const BG_COLOR: u32 = 0x000A_0A0A; // COLORREF is 0x00BBGGRR
// Text        #e5e5e5 = RGB(229,229,229)
const TEXT_COLOR: u32 = 0x00E5E5E5; // 0x00BBGGRR
// Bar         #22c55e = RGB(34,197,94)
const BAR_COLOR: u32 = 0x005EC522; // 0x00BBGGRR

static SPLASH_HWND: AtomicUsize = AtomicUsize::new(0);

struct SplashState {
    progress: f32, // 0.0 – 1.0, advances on each timer tick; never reaches 1.0
}

/// Spawn the native splash window on a background thread.
/// Returns immediately; the Win32 message loop runs on the spawned thread.
#[allow(unused_must_use)]
pub fn show() {
    std::thread::spawn(|| unsafe {
        let hinstance = GetModuleHandleW(None).expect("GetModuleHandleW failed");

        let class_name: Vec<u16> = "RushCutSplash\0".encode_utf16().collect();

        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(splash_wndproc),
            hInstance: hinstance.into(),
            lpszClassName: windows::core::PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassExW(&wc);

        let screen_w = GetSystemMetrics(SM_CXSCREEN);
        let screen_h = GetSystemMetrics(SM_CYSCREEN);
        let x = screen_w / 2 - SPLASH_W / 2;
        let y = screen_h / 2 - SPLASH_H / 2;

        // Allocate state on the heap; passed via CREATESTRUCT lpCreateParams, stored in GWLP_USERDATA
        let state = Box::new(SplashState { progress: 0.0 });
        let state_ptr = Box::into_raw(state) as isize;

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            windows::core::PCWSTR(class_name.as_ptr()),
            windows::core::PCWSTR("RushCut\0".encode_utf16().collect::<Vec<u16>>().as_ptr()),
            WS_POPUP,
            x,
            y,
            SPLASH_W,
            SPLASH_H,
            None,
            None,
            hinstance,
            Some(state_ptr as *const std::ffi::c_void),
        )
        .expect("CreateWindowExW failed");

        SPLASH_HWND.store(hwnd.0 as usize, Ordering::Relaxed);

        windows::Win32::UI::WindowsAndMessaging::ShowWindow(
            hwnd,
            windows::Win32::UI::WindowsAndMessaging::SW_SHOW,
        );

        SetTimer(hwnd, TIMER_ID, TIMER_MS, None);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
}

/// Post WM_CLOSE to the splash window. Thread-safe; the message loop on the splash thread
/// processes it and calls DestroyWindow, which triggers WM_DESTROY -> PostQuitMessage.
pub fn hide() {
    let val = SPLASH_HWND.swap(0, Ordering::Relaxed);
    if val != 0 {
        let hwnd = HWND(val as *mut core::ffi::c_void);
        unsafe {
            let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

#[allow(unused_must_use)]
unsafe extern "system" fn splash_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            // Retrieve lpCreateParams (our SplashState pointer) from CREATESTRUCT
            let cs = lparam.0 as *const CREATESTRUCTW;
            if !cs.is_null() {
                let state_ptr = (*cs).lpCreateParams as isize;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr);
            }
            LRESULT(0)
        }

        WM_TIMER => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SplashState;
            if !ptr.is_null() {
                let state = &mut *ptr;
                // Advance progress at 0.8% per 50ms tick — reaches ~80% in ~5s,
                // but the splash is always closed before that.
                state.progress = (state.progress + 0.008).min(0.82);
            }
            let _ = InvalidateRect(hwnd, None, false);
            LRESULT(0)
        }

        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);

            // --- Background ---
            let bg_brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(BG_COLOR));
            let mut rect = windows::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: SPLASH_W,
                bottom: SPLASH_H,
            };
            FillRect(hdc, &rect, bg_brush);
            DeleteObject(bg_brush);

            // --- Wordmark: "RushCut" ---
            let font_name: Vec<u16> = "Segoe UI Semibold\0".encode_utf16().collect();
            let hfont = CreateFontW(
                42,   // height (px)
                0, 0, 0,
                700,  // weight: FW_BOLD
                0, 0, 0,
                0, 0, 0, 0, 0,
                windows::core::PCWSTR(font_name.as_ptr()),
            );
            let old_font = SelectObject(hdc, hfont);
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, windows::Win32::Foundation::COLORREF(TEXT_COLOR));

            let text: Vec<u16> = "RushCut".encode_utf16().collect();
            TextOutW(hdc, 36, 38, &text);

            SelectObject(hdc, old_font);
            DeleteObject(hfont);

            // --- Progress bar ---
            let bar_x = 36;
            let bar_y = 118;
            let bar_w = SPLASH_W - 72; // 328px total width
            let bar_h = 4;

            // Track (background)
            let track_brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x001A1A1A));
            rect = windows::Win32::Foundation::RECT {
                left: bar_x,
                top: bar_y,
                right: bar_x + bar_w,
                bottom: bar_y + bar_h,
            };
            FillRect(hdc, &rect, track_brush);
            DeleteObject(track_brush);

            // Fill (progress)
            let progress = {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SplashState;
                if ptr.is_null() { 0.0_f32 } else { (*ptr).progress }
            };
            let fill_w = ((bar_w as f32) * progress) as i32;
            if fill_w > 0 {
                let bar_brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(BAR_COLOR));
                rect = windows::Win32::Foundation::RECT {
                    left: bar_x,
                    top: bar_y,
                    right: bar_x + fill_w,
                    bottom: bar_y + bar_h,
                };
                FillRect(hdc, &rect, bar_brush);
                DeleteObject(bar_brush);
            }

            // --- Subtext ---
            let sub_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
            let hfont_sub = CreateFontW(
                16, 0, 0, 0, 400, 0, 0, 0, 0, 0, 0, 0, 0,
                windows::core::PCWSTR(sub_name.as_ptr()),
            );
            let old_sub = SelectObject(hdc, hfont_sub);
            SetTextColor(hdc, windows::Win32::Foundation::COLORREF(0x00555555));
            let sub_text: Vec<u16> = "Starting up...".encode_utf16().collect();
            TextOutW(hdc, 36, 140, &sub_text);
            SelectObject(hdc, old_sub);
            DeleteObject(hfont_sub);

            EndPaint(hwnd, &ps);
            LRESULT(0)
        }

        WM_CLOSE => {
            KillTimer(hwnd, TIMER_ID);
            DestroyWindow(hwnd).ok();
            LRESULT(0)
        }

        WM_DESTROY => {
            // Drop the boxed SplashState to free the heap allocation
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut SplashState;
            if !ptr.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(ptr));
            }
            PostQuitMessage(0);
            LRESULT(0)
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
