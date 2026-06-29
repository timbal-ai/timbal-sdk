import type { AuthProvider } from '../../types';

const DEFAULT_PROVIDERS: AuthProvider[] = [
  'email',
  'google',
  'microsoft',
  'github',
];

const OAUTH_PROVIDERS = ['google', 'microsoft', 'github'] as const;
type OAuthLoginProvider = (typeof OAUTH_PROVIDERS)[number];

export interface RenderLoginPageOptions {
  /**
   * Login methods to render. Defaults to all four (identical to the historical
   * page). Disabled providers are removed from the markup server-side — not
   * just hidden — so the buttons can't be re-enabled client-side.
   */
  providers?: AuthProvider[];
}

/**
 * Remove disabled login options from the rendered markup. Operates on the
 * stable `data-provider-wrap` / `data-provider` markers. Each OAuth wrap and
 * the email form/alert/divider contain no nested `<div>`/`<form>` of their own,
 * so a single non-greedy match to the next close tag is exact.
 */
function applyProviderFilter(
  html: string,
  providers: AuthProvider[],
): string {
  let out = html;

  for (const p of OAUTH_PROVIDERS) {
    if (!providers.includes(p)) {
      out = out.replace(
        new RegExp(
          `\\s*<div class="oauth-btn-wrap" data-provider-wrap="${p}">[\\s\\S]*?</div>`,
        ),
        '',
      );
    }
  }

  const hasOauth = OAUTH_PROVIDERS.some((p: OAuthLoginProvider) =>
    providers.includes(p),
  );
  const hasEmail = providers.includes('email');

  if (!hasEmail) {
    out = out.replace(
      /\s*<form[\s\S]*?id="magic-link-form"[\s\S]*?<\/form>/,
      '',
    );
    out = out.replace(/\s*<div\s+id="email-sent"[\s\S]*?<\/div>/, '');
  }

  // The "or" divider only makes sense between OAuth buttons and the email form.
  if (!(hasOauth && hasEmail)) {
    out = out.replace(/\s*<div class="divider">[\s\S]*?<\/div>/, '');
  }

  // Drop the now-empty OAuth stack wrapper when no OAuth providers remain.
  if (!hasOauth) {
    out = out.replace(/\s*<div class="oauth-stack">[\s\S]*?<\/div>/, '');
  }

  return out;
}

/**
 * Renders the default Timbal login page.
 * @param prefix - Route prefix ("" or "/api")
 * @param opts - Optional provider filtering. Default: all providers (= today).
 */
export function renderLoginPage(
  prefix: string,
  opts: RenderLoginPageOptions = {},
): string {
  const html = `
<!doctype html>
<html lang="en" data-theme="light">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link
            rel="icon"
            type="image/png"
            href="https://content.timbal.ai/assets/favicon.png"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
            rel="stylesheet"
        />
        <title>Sign In - Timbal</title>
        <script>
            (function () {
                var STORAGE_KEY = "timbal_login_theme";
                function normalizeTheme(value) {
                    return value === "dark" ? "dark" : "light";
                }
                function readStoredTheme() {
                    try {
                        var stored = localStorage.getItem(STORAGE_KEY);
                        if (stored === "dark" || stored === "light") return stored;
                        var legacy = localStorage.getItem("theme");
                        if (legacy === "dark" || legacy === "light") return legacy;
                    } catch (e) {}
                    return "light";
                }
                function applyTheme(theme) {
                    var t = normalizeTheme(theme);
                    document.documentElement.setAttribute("data-theme", t);
                    document.documentElement.style.colorScheme = t;
                    try {
                        localStorage.setItem(STORAGE_KEY, t);
                    } catch (e) {}
                }
                applyTheme(readStoredTheme());
            })();
        </script>
        <style>
            :root {
                --font-sans: "Inter", -apple-system, BlinkMacSystemFont,
                    "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }

            html[data-theme="light"] {
                color-scheme: light;
            }

            html[data-theme="dark"] {
                color-scheme: dark;
            }

            html[data-theme="light"] {
                --page-bg: #ffffff;
                --panel-bg: #ffffff;
                --panel-border: rgba(228, 228, 231, 0.5);
                --pattern-color: rgba(24, 24, 27, 0.055);
                --pattern-glow: rgba(24, 24, 27, 0.06);
                --grid-line: rgba(24, 24, 27, 0.04);
                --dot-color: rgba(24, 24, 27, 0.14);
                --text-primary: #09090b;
                --text-secondary: #71717a;
                --text-muted: #a1a1aa;
                --surface-solid: #ffffff;
                --surface-gradient-top: #ffffff;
                --surface-gradient-bottom: rgba(250, 250, 250, 0.7);
                --surface-border: rgba(228, 228, 231, 0.8);
                --surface-border-hover: #d4d4d8;
                --surface-shadow: 0 1px 2px -0.5px rgba(0, 0, 0, 0.05);
                --btn-secondary-hover-top: rgba(250, 250, 250, 0.5);
                --btn-secondary-hover-bottom: rgba(244, 244, 245, 0.65);
                --btn-secondary-active-top: rgba(244, 244, 245, 0.7);
                --btn-secondary-active-bottom: rgba(228, 228, 231, 0.65);
                --btn-primary-top: #262626;
                --btn-primary-bottom: #000000;
                --btn-primary-hover-top: #404040;
                --btn-primary-hover-bottom: #171717;
                --btn-primary-text: #ffffff;
                --btn-primary-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.15);
                --input-text: #18181b;
                --input-placeholder: #a1a1aa;
                --input-border-focus: #a1a1aa;
                --divider: #e4e4e7;
                --error-bg: #fef2f2;
                --error-border: #fecaca;
                --error-text: #b91c1c;
                --success-bg: #ecfdf5;
                --success-border: #a7f3d0;
                --success-text: #047857;
                --badge-bg: #18181b;
                --badge-text: #fafafa;
                --last-border: #18181b;
                --theme-toggle: #a1a1aa;
                --theme-toggle-hover: #52525b;
                --mark-frame-border: rgba(212, 212, 216, 0.5);
                --mark-frame-bg: rgba(228, 228, 231, 0.3);
            }

            html[data-theme="dark"] {
                --page-bg: #0a0a0a;
                --panel-bg: #111111;
                --panel-border: rgba(255, 255, 255, 0.05);
                --pattern-color: rgba(255, 255, 255, 0.045);
                --pattern-glow: rgba(255, 255, 255, 0.05);
                --grid-line: rgba(255, 255, 255, 0.035);
                --dot-color: rgba(255, 255, 255, 0.12);
                --text-primary: #fafafa;
                --text-secondary: #a1a1aa;
                --text-muted: #71717a;
                --surface-solid: #18181b;
                --surface-gradient-top: rgba(255, 255, 255, 0.05);
                --surface-gradient-bottom: rgba(255, 255, 255, 0.025);
                --surface-border: rgba(255, 255, 255, 0.08);
                --surface-border-hover: rgba(255, 255, 255, 0.15);
                --surface-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
                --btn-secondary-hover-top: rgba(255, 255, 255, 0.07);
                --btn-secondary-hover-bottom: rgba(255, 255, 255, 0.045);
                --btn-secondary-active-top: rgba(255, 255, 255, 0.1);
                --btn-secondary-active-bottom: rgba(255, 255, 255, 0.07);
                --btn-primary-top: #ffffff;
                --btn-primary-bottom: #e5e5e5;
                --btn-primary-hover-top: #ffffff;
                --btn-primary-hover-bottom: #f5f5f5;
                --btn-primary-text: #171717;
                --btn-primary-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.4);
                --input-text: #f4f4f5;
                --input-placeholder: #71717a;
                --input-border-focus: rgba(255, 255, 255, 0.2);
                --divider: rgba(255, 255, 255, 0.1);
                --error-bg: rgba(69, 10, 10, 0.4);
                --error-border: rgba(127, 29, 29, 0.5);
                --error-text: #fca5a5;
                --success-bg: rgba(6, 78, 59, 0.3);
                --success-border: rgba(6, 78, 59, 0.4);
                --success-text: #6ee7b7;
                --badge-bg: #fafafa;
                --badge-text: #18181b;
                --last-border: #fafafa;
                --theme-toggle: #71717a;
                --theme-toggle-hover: #d4d4d8;
                --mark-frame-border: rgba(82, 82, 91, 0.45);
                --mark-frame-bg: rgba(39, 39, 42, 0.45);
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: var(--font-sans);
                background-color: var(--page-bg);
                color: var(--text-primary);
                min-height: 100vh;
                width: 100%;
                -webkit-font-smoothing: antialiased;
            }

            .page-shell {
                min-height: 100vh;
                width: 100%;
            }

            .page-card {
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                width: 100%;
                overflow: hidden;
                background-color: var(--panel-bg);
            }

            .page-card::before {
                content: "";
                position: absolute;
                inset: 0;
                pointer-events: none;
                opacity: 0.9;
                background-image:
                    radial-gradient(
                        ellipse 55% 40% at 8% 12%,
                        var(--pattern-glow),
                        transparent 68%
                    ),
                    radial-gradient(
                        ellipse 50% 38% at 92% 18%,
                        var(--pattern-glow),
                        transparent 70%
                    ),
                    radial-gradient(
                        ellipse 48% 42% at 14% 88%,
                        var(--pattern-glow),
                        transparent 72%
                    ),
                    radial-gradient(
                        ellipse 52% 40% at 88% 82%,
                        var(--pattern-glow),
                        transparent 70%
                    ),
                    linear-gradient(
                        135deg,
                        var(--grid-line) 1px,
                        transparent 1px
                    ),
                    linear-gradient(
                        45deg,
                        var(--grid-line) 1px,
                        transparent 1px
                    );
                background-size:
                    auto,
                    auto,
                    auto,
                    auto,
                    56px 56px,
                    56px 56px;
            }

            .page-card::after {
                content: "";
                position: absolute;
                inset: 0;
                pointer-events: none;
                background-image: radial-gradient(
                    var(--dot-color) 0.75px,
                    transparent 0.75px
                );
                background-size: 20px 20px;
                mask-image: radial-gradient(
                    ellipse 75% 65% at 50% 48%,
                    black 15%,
                    transparent 78%
                );
                opacity: 0.45;
            }

            .bg-glyphs {
                position: absolute;
                inset: 0;
                pointer-events: none;
                overflow: hidden;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                font-size: 0.625rem;
                line-height: 1.6;
                color: var(--pattern-color);
                letter-spacing: 0.1em;
                user-select: none;
            }

            .bg-glyphs span {
                position: absolute;
                white-space: nowrap;
                opacity: 0.55;
            }

            .bg-glyphs .glyph-dim {
                opacity: 0.28;
                font-size: 0.5625rem;
            }

            .bg-glyphs .glyph-faint {
                opacity: 0.16;
                font-size: 0.5rem;
            }

            .bg-ring {
                position: absolute;
                pointer-events: none;
                border: 1px solid var(--grid-line);
                border-radius: 9999px;
                opacity: 0.35;
            }

            .bg-ring-1 {
                width: 28rem;
                height: 28rem;
                top: -8rem;
                right: -10rem;
            }

            .bg-ring-2 {
                width: 22rem;
                height: 22rem;
                bottom: -7rem;
                left: -8rem;
            }

            .theme-toggle {
                position: absolute;
                top: 1.5rem;
                right: 1.5rem;
                z-index: 50;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 2rem;
                height: 2rem;
                padding: 0;
                border: 1px solid var(--surface-border);
                border-radius: 9999px;
                background-color: var(--surface-solid);
                background-image: linear-gradient(
                    to bottom,
                    var(--surface-gradient-top),
                    var(--surface-gradient-bottom)
                );
                box-shadow: var(--surface-shadow);
                color: var(--theme-toggle);
                cursor: pointer;
                transition:
                    color 0.15s ease,
                    border-color 0.15s ease;
            }

            .theme-toggle:hover {
                border-color: var(--surface-border-hover);
            }

            .theme-toggle:hover {
                color: var(--theme-toggle-hover);
            }

            .theme-toggle svg {
                width: 0.875rem;
                height: 0.875rem;
                flex-shrink: 0;
            }

            @media (min-width: 1024px) {
                .theme-toggle {
                    top: 2rem;
                    right: 2rem;
                }
            }

            .brand {
                display: flex;
                justify-content: center;
                align-items: center;
                width: 100%;
                margin-bottom: 0.25rem;
            }

            .mark-frame {
                position: relative;
                overflow: hidden;
                border: 1px solid var(--surface-border);
                border-radius: 0.5rem;
                background-color: var(--surface-solid);
                background-image: linear-gradient(
                    to bottom,
                    var(--surface-gradient-top),
                    var(--surface-gradient-bottom)
                );
                padding: 0.25rem;
                box-shadow: var(--surface-shadow);
            }

            .mark-frame img {
                position: relative;
                z-index: 1;
                width: 1.75rem;
                height: 1.75rem;
                object-fit: contain;
                display: block;
            }

            .form-column {
                position: relative;
                z-index: 10;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                width: 100%;
                max-width: 26rem;
                padding: 2rem 1.5rem;
            }

            .auth-card {
                width: 100%;
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
                text-align: center;
            }

            .header-text {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.375rem;
            }

            .header-text h1 {
                font-size: clamp(1.625rem, 5vw, 2rem);
                font-weight: 600;
                letter-spacing: -0.03em;
                line-height: 1.15;
                color: var(--text-primary);
            }

            .header-text p {
                font-size: 0.9375rem;
                font-weight: 400;
                color: var(--text-secondary);
                max-width: 18rem;
            }

            .field-group {
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                width: 100%;
            }

            .oauth-stack {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }

            .oauth-btn-wrap {
                position: relative;
            }

            .btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.5rem;
                width: 100%;
                min-height: 2.5rem;
                height: 2.5rem;
                padding: 0 1rem;
                font-size: 0.875rem;
                font-weight: 400;
                font-family: inherit;
                line-height: 1.25;
                border-radius: 9999px;
                cursor: pointer;
                text-decoration: none;
                border: 1px solid transparent;
                position: relative;
                -webkit-appearance: none;
                appearance: none;
                outline: none;
                transition:
                    background 200ms ease,
                    border-color 200ms ease,
                    box-shadow 200ms ease,
                    color 200ms ease;
            }

            .btn:focus-visible {
                outline: 2px solid rgba(24, 24, 27, 0.15);
                outline-offset: 2px;
            }

            html[data-theme="dark"] .btn:focus-visible {
                outline-color: rgba(255, 255, 255, 0.2);
            }

            /* TimbalV2 secondary — roles/users/settings modals */
            .btn-outline {
                color: var(--text-primary);
                border-color: var(--surface-border);
                background-color: var(--surface-solid);
                background-image: linear-gradient(
                    to bottom,
                    var(--surface-gradient-top),
                    var(--surface-gradient-bottom)
                );
                box-shadow: var(--surface-shadow);
            }

            .btn-outline:hover {
                border-color: var(--surface-border-hover);
                background-image: linear-gradient(
                    to bottom,
                    var(--btn-secondary-hover-top),
                    var(--btn-secondary-hover-bottom)
                );
            }

            .btn-outline:active {
                background-image: linear-gradient(
                    to bottom,
                    var(--btn-secondary-active-top),
                    var(--btn-secondary-active-bottom)
                );
            }

            .btn-outline.btn-last-used {
                border-width: 2px;
                border-color: var(--last-border);
            }

            /* TimbalV2 primary */
            .btn-primary {
                color: var(--btn-primary-text);
                border-color: transparent;
                background-image: linear-gradient(
                    to bottom,
                    var(--btn-primary-top),
                    var(--btn-primary-bottom)
                );
                box-shadow: var(--btn-primary-shadow);
            }

            .btn-primary:hover {
                background-image: linear-gradient(
                    to bottom,
                    var(--btn-primary-hover-top),
                    var(--btn-primary-hover-bottom)
                );
            }

            .btn-loading {
                opacity: 0.7;
                cursor: wait;
            }

            .badge-last-used {
                pointer-events: none;
                position: absolute;
                top: 0;
                left: 76%;
                z-index: 1;
                transform: translate(-50%, -50%);
                padding: 0.125rem 0.5rem;
                font-size: 0.625rem;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                line-height: 1;
                color: var(--badge-text);
                background-color: var(--badge-bg);
                border-radius: 9999px;
            }

            .divider {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                margin: 0.25rem 0;
            }

            .divider::before,
            .divider::after {
                content: "";
                flex: 1;
                height: 1px;
                background: var(--divider);
            }

            .divider span {
                font-size: 0.75rem;
                font-weight: 400;
                color: var(--text-muted);
            }

            .input-group {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }

            /* Org settings / studio field chrome */
            input[type="email"] {
                height: 2.5rem;
                width: 100%;
                border-radius: 9999px;
                border: 1px solid var(--surface-border);
                background-color: var(--surface-solid);
                background-image: linear-gradient(
                    to bottom,
                    var(--surface-gradient-top),
                    var(--surface-gradient-bottom)
                );
                box-shadow: var(--surface-shadow);
                padding: 0 1rem;
                font-size: 0.8125rem;
                font-weight: 400;
                line-height: 1.35;
                font-family: inherit;
                color: var(--input-text);
                outline: none;
                transition:
                    border-color 200ms ease,
                    box-shadow 200ms ease;
            }

            input[type="email"]::placeholder {
                color: var(--input-placeholder);
            }

            input[type="email"]:hover {
                border-color: var(--surface-border-hover);
            }

            input[type="email"]:focus {
                border-color: var(--input-border-focus);
            }

            .icon {
                width: 1.125rem;
                height: 1.125rem;
                flex-shrink: 0;
            }

            .alert {
                padding: 0.625rem 0.75rem;
                border-radius: 0.5rem;
                font-size: 0.875rem;
                display: none;
            }

            .alert.show {
                display: block;
            }

            .alert-error {
                background: var(--error-bg);
                border: 1px solid var(--error-border);
                color: var(--error-text);
            }

            .alert-success {
                background: var(--success-bg);
                border: 1px solid var(--success-border);
                color: var(--success-text);
                text-align: center;
            }

            .terms-text {
                font-size: 0.75rem;
                font-weight: 400;
                color: var(--text-secondary);
                line-height: 1.625;
            }

            .terms-text a {
                color: inherit;
                text-decoration: underline;
                text-underline-offset: 2px;
            }

            .terms-text a:hover {
                color: var(--text-primary);
            }

            .theme-icon-sun,
            .theme-icon-moon {
                display: none;
            }

            html[data-theme="light"] .theme-icon-moon {
                display: block;
            }

            html[data-theme="dark"] .theme-icon-sun {
                display: block;
            }
        </style>
    </head>
    <body>
        <div class="page-shell">
            <div class="page-card">
                <button
                    type="button"
                    class="theme-toggle"
                    id="theme-toggle"
                    aria-label="Toggle theme"
                >
                    <svg
                        class="theme-icon-sun"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="1.5"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                        />
                    </svg>
                    <svg
                        class="theme-icon-moon"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="1.5"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                        />
                    </svg>
                </button>

                <div class="bg-ring bg-ring-1" aria-hidden="true"></div>
                <div class="bg-ring bg-ring-2" aria-hidden="true"></div>
                <div class="bg-glyphs" aria-hidden="true">
                    <span style="top: 6%; left: 5%">timbal · ai</span>
                    <span class="glyph-dim" style="top: 10%; left: 18%">0x4a · ai</span>
                    <span class="glyph-faint" style="top: 14%; left: 8%">λ ctx</span>
                    <span style="top: 8%; right: 6%">embed · 101</span>
                    <span class="glyph-dim" style="top: 16%; right: 14%">vector</span>
                    <span class="glyph-faint" style="top: 22%; right: 5%">fts · sql</span>
                    <span class="glyph-dim" style="top: 34%; left: 3%">run_id</span>
                    <span class="glyph-faint" style="top: 42%; left: 7%">workflow</span>
                    <span class="glyph-dim" style="top: 38%; right: 4%">agent</span>
                    <span class="glyph-faint" style="top: 48%; right: 9%">tool · mcp</span>
                    <span style="bottom: 28%; left: 6%">timbal · sync</span>
                    <span class="glyph-dim" style="bottom: 22%; left: 16%">kb · query</span>
                    <span class="glyph-faint" style="bottom: 16%; left: 8%">hybrid</span>
                    <span style="bottom: 26%; right: 7%">deploy · ok</span>
                    <span class="glyph-dim" style="bottom: 18%; right: 15%">org · iam</span>
                    <span class="glyph-faint" style="bottom: 10%; right: 6%">role · grant</span>
                    <span class="glyph-faint" style="bottom: 8%; left: 42%">auth · token</span>
                </div>

                <div class="form-column">
                    <div class="auth-card">
                        <div class="brand">
                            <div class="mark-frame">
                                <img
                                    src="https://app.timbal.ai/onboarding-welcome-mark.png?v=2"
                                    alt="Timbal"
                                    width="28"
                                    height="28"
                                    draggable="false"
                                />
                            </div>
                        </div>

                        <div class="header-text">
                            <h1>Welcome to Timbal</h1>
                            <p>The end-to-end AI ecosystem</p>
                        </div>

                        <div id="error" class="alert alert-error"></div>

                        <div class="field-group">
                            <div class="oauth-stack">
                                <div class="oauth-btn-wrap" data-provider-wrap="google">
                                    <a
                                        id="google-btn"
                                        href="#"
                                        class="btn btn-outline track-auth"
                                        data-provider="google"
                                    >
                                        <svg
                                            class="icon"
                                            viewBox="0 0 18 18"
                                            xmlns="http://www.w3.org/2000/svg"
                                        >
                                            <path
                                                d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
                                                fill="#4285F4"
                                            />
                                            <path
                                                d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
                                                fill="#34A853"
                                            />
                                            <path
                                                d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
                                                fill="#FBBC05"
                                            />
                                            <path
                                                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
                                                fill="#EA4335"
                                            />
                                        </svg>
                                        Continue with Google
                                    </a>
                                </div>

                                <div class="oauth-btn-wrap" data-provider-wrap="microsoft">
                                    <a
                                        id="microsoft-btn"
                                        href="#"
                                        class="btn btn-outline track-auth"
                                        data-provider="microsoft"
                                    >
                                        <svg
                                            class="icon"
                                            viewBox="0 0 23 23"
                                            xmlns="http://www.w3.org/2000/svg"
                                        >
                                            <path fill="#f25022" d="M1 1H10V10H1z" />
                                            <path fill="#7fba00" d="M12 1H21V10H12z" />
                                            <path fill="#00a4ef" d="M1 12H10V21H1z" />
                                            <path fill="#ffb900" d="M12 12H21V21H12z" />
                                        </svg>
                                        Continue with Microsoft
                                    </a>
                                </div>

                                <div class="oauth-btn-wrap" data-provider-wrap="github">
                                    <a
                                        id="github-btn"
                                        href="#"
                                        class="btn btn-outline track-auth"
                                        data-provider="github"
                                    >
                                        <svg
                                            class="icon"
                                            viewBox="0 0 24 24"
                                            xmlns="http://www.w3.org/2000/svg"
                                        >
                                            <path
                                                fill="currentColor"
                                                d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
                                            />
                                        </svg>
                                        Continue with GitHub
                                    </a>
                                </div>
                            </div>

                            <div class="divider">
                                <span>or</span>
                            </div>

                            <form
                                id="magic-link-form"
                                class="input-group"
                                data-provider="email"
                            >
                                <input
                                    type="email"
                                    id="email"
                                    name="email"
                                    placeholder="name@company.com"
                                    required
                                    autocomplete="email"
                                    aria-label="Email address"
                                />
                                <div class="oauth-btn-wrap" data-provider-wrap="email">
                                    <button
                                        type="submit"
                                        id="email-btn"
                                        class="btn btn-primary"
                                    >
                                        Continue with email
                                    </button>
                                </div>
                            </form>
                            <div
                                id="email-sent"
                                class="alert alert-success"
                                style="display: none"
                            >
                                Check your inbox. We've sent you a secure sign-in link.
                            </div>

                            <p class="terms-text">
                                By signing in, you agree to the
                                <a
                                    href="https://app.timbal.ai/legal/terms-use/"
                                    target="_blank"
                                    >Terms of Use</a
                                >,
                                <a
                                    href="https://app.timbal.ai/legal/fair-usage/"
                                    target="_blank"
                                    >Fair Usage Policy</a
                                >, and
                                <a
                                    href="https://app.timbal.ai/legal/privacy-policy/"
                                    target="_blank"
                                    >Privacy Notice</a
                                >.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            (function initTheme() {
                const STORAGE_KEY = "timbal_login_theme";
                const root = document.documentElement;

                function normalizeTheme(value) {
                    return value === "dark" ? "dark" : "light";
                }

                function applyTheme(theme) {
                    const t = normalizeTheme(theme);
                    root.setAttribute("data-theme", t);
                    root.style.colorScheme = t;
                    try {
                        localStorage.setItem(STORAGE_KEY, t);
                    } catch (e) {}
                    const toggle = document.getElementById("theme-toggle");
                    if (toggle) {
                        toggle.setAttribute(
                            "aria-label",
                            t === "dark"
                                ? "Switch to light mode"
                                : "Switch to dark mode",
                        );
                    }
                }

                function readStoredTheme() {
                    try {
                        const stored = localStorage.getItem(STORAGE_KEY);
                        if (stored === "dark" || stored === "light") {
                            return stored;
                        }
                        const legacy = localStorage.getItem("theme");
                        if (legacy === "dark" || legacy === "light") {
                            return legacy;
                        }
                    } catch (e) {}
                    return (
                        root.getAttribute("data-theme") === "dark"
                            ? "dark"
                            : "light"
                    );
                }

                applyTheme(readStoredTheme());

                const toggle = document.getElementById("theme-toggle");
                if (toggle) {
                    toggle.addEventListener("click", () => {
                        const current = root.getAttribute("data-theme");
                        applyTheme(
                            current === "dark" ? "light" : "dark",
                        );
                    });
                }
            })();

            const errorEl = document.getElementById("error");
            const urlParams = new URLSearchParams(window.location.search);
            const error = urlParams.get("error");
            const redirectUri =
                urlParams.get("redirect_uri") || window.location.href;
            const baseUrl = window.location.origin + "${prefix}";

            let returnTo = urlParams.get("return_to");
            if (!returnTo && document.referrer) {
                try {
                    const ref = new URL(document.referrer);
                    if (ref.origin === window.location.origin) {
                        returnTo = ref.pathname + ref.search;
                    }
                } catch (e) {}
            }
            if (returnTo) {
                document.cookie =
                    "timbal_return_to=" +
                    encodeURIComponent(returnTo) +
                    "; path=/; max-age=600; SameSite=Lax";
            } else {
                document.cookie = "timbal_return_to=; path=/; max-age=0";
            }

            const githubBtn = document.getElementById("github-btn");
            const googleBtn = document.getElementById("google-btn");
            const microsoftBtn = document.getElementById("microsoft-btn");

            if (githubBtn) githubBtn.href = \`\${baseUrl}/auth/github\`;
            if (googleBtn) googleBtn.href = \`\${baseUrl}/auth/google\`;
            if (microsoftBtn) microsoftBtn.href = \`\${baseUrl}/auth/microsoft\`;

            if (error) {
                const messages = {
                    no_access: "You do not have access to this resource",
                    auth_failed: "Authentication failed. Please try again",
                    invalid_token: "You do not have access to this application",
                    no_tokens:
                        "No authentication tokens received. Please try again",
                    access_denied: "Access was denied",
                };
                errorEl.textContent = messages[error] || "Login failed";
                errorEl.classList.add("show");
            }

            const magicLinkForm = document.getElementById("magic-link-form");
            const emailInput = document.getElementById("email");
            const emailBtn = document.getElementById("email-btn");
            const emailSentMsg = document.getElementById("email-sent");
            const originalBtnText = emailBtn
                ? emailBtn.innerHTML
                : "Continue with email";

            if (magicLinkForm) {
                magicLinkForm.addEventListener("submit", async (e) => {
                    e.preventDefault();
                    const email = emailInput.value.trim();
                    if (!email) return;

                    errorEl.classList.remove("show");
                    emailInput.disabled = true;
                    emailBtn.disabled = true;
                    emailBtn.classList.add("btn-loading");
                    emailBtn.innerHTML = "Sending…";

                    try {
                        const response = await fetch(
                            \`\${baseUrl}/auth/magic-link\`,
                            {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    email: email,
                                    redirect_uri: redirectUri,
                                }),
                            },
                        );

                        if (response.status === 204 || response.ok) {
                            magicLinkForm.style.display = "none";
                            emailSentMsg.style.display = "block";
                            localStorage.setItem(
                                "timbal_last_auth_provider",
                                "email",
                            );
                        } else {
                            throw new Error("Unexpected response");
                        }
                    } catch (err) {
                        console.error("Magic link error:", err);
                        errorEl.textContent =
                            "Something went wrong. Please try again.";
                        errorEl.classList.add("show");
                        emailInput.disabled = false;
                        emailBtn.disabled = false;
                        emailBtn.classList.remove("btn-loading");
                        emailBtn.innerHTML = originalBtnText;
                    }
                });
            }

            (function handleLastUsedProvider() {
                const STORAGE_KEY = "timbal_last_auth_provider";
                const lastProvider = localStorage.getItem(STORAGE_KEY);

                function markLastUsed(provider) {
                    const wrap = document.querySelector(
                        \`[data-provider-wrap="\${provider}"]\`,
                    );
                    if (!wrap) return;

                    const btn = wrap.querySelector(".btn");
                    if (btn) btn.classList.add("btn-last-used");

                    const badge = document.createElement("span");
                    badge.className = "badge-last-used";
                    badge.textContent = "Last used";
                    wrap.appendChild(badge);
                }

                if (lastProvider) {
                    markLastUsed(lastProvider);
                }

                const trackingBtns = document.querySelectorAll(".track-auth");
                trackingBtns.forEach((btn) => {
                    btn.addEventListener("click", () => {
                        const provider = btn.getAttribute("data-provider");
                        if (provider) {
                            localStorage.setItem(STORAGE_KEY, provider);
                        }
                    });
                });
            })();
        </script>
    </body>
</html>
`;

  return applyProviderFilter(html, opts.providers ?? DEFAULT_PROVIDERS);
}
