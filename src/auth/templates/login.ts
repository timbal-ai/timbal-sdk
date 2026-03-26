/**
 * Renders the default Timbal login page.
 * @param prefix - Route prefix ("" or "/api")
 */
export function renderLoginPage(prefix: string): string {
  return `
<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link
            rel="icon"
            type="image/png"
            href="https://content.timbal.ai/assets/favicon.png"
        />
        <title>Sign In - Timbal</title>
        <style>
            :root {
                /* --- Design Tokens --- */
                --bg-left: #0a0a0a; /* Very dark grey for left column */
                --bg-card: #000000; /* Pure black for the card */
                --bg-right: #030303; /* Deep black for right column */

                --text-primary: #f4f4f5;
                --text-secondary: #d4d4d8;
                --text-muted: #52525b;

                --border-color: #27272a;
                --primary: #fafafa;
                --primary-foreground: #18181b;

                --radius: 12px;
                --font-sans:
                    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                    "Helvetica Neue", Arial, sans-serif;

                --accent-green: #22c55e;
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: var(--font-sans);
                background-color: var(--bg-left);
                color: var(--text-primary);
                height: 100vh;
                width: 100vw;
                overflow: hidden;
                -webkit-font-smoothing: antialiased;
                display: flex;
            }

            /* --- LEFT COLUMN --- */
            .col-left {
                width: 50%;
                height: 100%;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                background-color: var(--bg-left);
                position: relative;
                z-index: 20;
                padding: 2rem;
                /* Static fallback border */
                border-right: 1px solid #121212;
            }

            /* --- ANIMATED LINE (Going UP) --- */
            .col-left::after {
                content: "";
                position: absolute;
                top: 0;
                right: -1px;
                width: 1px;
                height: 100%;
                z-index: 50;
                /* Green Gradient */
                background: linear-gradient(
                    to top,
                    rgba(34, 197, 94, 0) 0%,
                    rgba(34, 197, 94, 0) 40%,
                    rgba(34, 197, 94, 0.8) 50%,
                    rgba(34, 197, 94, 0) 60%,
                    rgba(34, 197, 94, 0) 100%
                );
                background-size: 100% 300%;
                /* Moving Upwards */
                animation: border-flow-up 4s ease-in-out infinite;
            }

            @keyframes border-flow-up {
                0% {
                    background-position: 0% 0%;
                }
                100% {
                    background-position: 0% 100%;
                }
            }

            /* --- RIGHT COLUMN --- */
            .col-right {
                width: 50%;
                height: 100%;
                position: relative;
                background-color: var(--bg-right);
                overflow: hidden;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
            }

            /* --- RESPONSIVE LOGIC --- */
            @media (max-width: 900px) {
                body {
                    flex-direction: column;
                    overflow-y: auto;
                }

                /* Left column takes full width */
                .col-left {
                    width: 100%;
                    height: 100%;
                    min-height: 100vh;
                    border-right: none;
                    padding: 1rem;
                }
                /* Remove the animated line on mobile */
                .col-left::after {
                    display: none;
                }

                /* Remove right column entirely */
                .col-right {
                    display: none;
                }

                /* Center logo horizontally on mobile */
                .brand-corner {
                    top: 1.5rem;
                    left: 50%;
                    transform: translateX(-50%);
                }

                /* Remove card styling on mobile */
                .auth-card {
                    max-width: 100%;
                    background: transparent;
                    border: none;
                    box-shadow: none;
                    padding: 1.5rem 0;
                }
            }

            /* --- LOGO (Top Left) --- */
            .brand-corner {
                position: absolute;
                top: 2rem;
                left: 2rem;
                z-index: 30;
                opacity: 0.9;
                transition: opacity 0.2s;
            }
            .brand-corner:hover {
                opacity: 1;
            }

            .logo {
                height: 20px;
                width: auto;
                fill: #fff;
            }

            /* --- Canvas for Dots (Background) --- */
            canvas {
                display: block;
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 1;
                pointer-events: none;
                opacity: 0.7;
            }

            /* --- LOGO SLIDER --- */
            .logo-slider-wrapper {
                position: absolute;
                bottom: 3rem;
                left: 0;
                right: 0;
                z-index: 10;
            }

            .trusted-label {
                font-size: 0.65rem;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: #a1a1aa;
                margin-bottom: 1.25rem;
                font-weight: 500;
                padding-left: 3rem;
            }

            .logo-slider-container {
                position: relative;
                width: 100%;
                overflow: hidden;
            }

            .logo-slider-container::before,
            .logo-slider-container::after {
                content: "";
                position: absolute;
                top: 0;
                bottom: 0;
                width: 100px;
                z-index: 20;
                pointer-events: none;
            }

            .logo-slider-container::before {
                left: 0;
                background: linear-gradient(
                    to right,
                    var(--bg-right) 0%,
                    transparent 100%
                );
            }

            .logo-slider-container::after {
                right: 0;
                background: linear-gradient(
                    to left,
                    var(--bg-right) 0%,
                    transparent 100%
                );
            }

            .logo-track {
                display: flex;
                width: max-content;
            }

            .logo-set {
                display: flex;
                align-items: center;
                gap: 4rem;
                padding-right: 4rem;
                flex-shrink: 0;
                animation: scroll-logos 25s linear infinite;
            }

            @keyframes scroll-logos {
                0% {
                    transform: translateX(0);
                }
                100% {
                    transform: translateX(-100%);
                }
            }

            .logo-item {
                height: 20px;
                width: auto;
                opacity: 0.45;
                filter: grayscale(100%) brightness(1.8);
                flex-shrink: 0;
            }

            /* --- Docs Button --- */
            .docs-link {
                position: absolute;
                top: 2rem;
                right: 2rem;
                z-index: 30;
                display: flex;
                align-items: center;
                gap: 0.4rem;
                padding: 0.5rem 0.85rem;
                font-size: 0.75rem;
                font-weight: 500;
                color: #a1a1aa;
                background: #18181b;
                border: 1px solid #27272a;
                border-radius: 6px;
                text-decoration: none;
                transition: all 0.15s ease;
            }

            .docs-link:hover {
                color: #d4d4d8;
                background: #1f1f23;
                border-color: #3f3f46;
            }

            .docs-link svg {
                width: 14px;
                height: 14px;
                opacity: 0.7;
            }

            /* --- Auth Card --- */
            .auth-card {
                width: 100%;
                max-width: 400px;
                background-color: var(--bg-card);
                border: 1px solid var(--border-color);
                border-radius: var(--radius);
                padding: 2.5rem;
                box-shadow:
                    0 0 0 1px rgba(255, 255, 255, 0.02),
                    0 20px 40px -12px rgba(0, 0, 0, 1);
                display: flex;
                flex-direction: column;
                gap: 2rem;
            }

            .header-text h1 {
                font-size: 1.75rem;
                font-weight: 400;
                letter-spacing: -0.01em;
                margin-bottom: 0.5rem;
                color: #ededed;
            }
            .header-text p {
                color: var(--text-secondary);
                font-size: 0.95rem;
                line-height: 1.5;
            }

            .field-group {
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                width: 100%;
            }

            .btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.6rem;
                width: 100%;
                height: 2.75rem;
                padding: 0 1rem;
                font-size: 0.875rem;
                font-weight: 500;
                font-family: inherit;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s;
                text-decoration: none;
                border: 1px solid transparent;
                position: relative;
                -webkit-appearance: none;
                appearance: none;
                outline: none;
                background: transparent;
            }

            .btn-primary {
                background-color: var(--primary);
                color: var(--primary-foreground);
            }
            .btn-primary:hover {
                opacity: 0.9;
            }

            .btn-outline {
                background-color: transparent;
                border-color: var(--border-color);
                color: var(--text-primary);
            }
            .btn-outline:hover {
                background-color: var(--bg-muted);
                border-color: #3f3f46;
            }

            .btn-disabled {
                opacity: 0.5;
                cursor: not-allowed;
                pointer-events: none;
            }
            .btn-loading {
                opacity: 0.7;
                cursor: wait;
            }

            /* --- "Last" Badge --- */
            .badge-last-used {
                position: absolute;
                top: -8px;
                right: -8px;
                font-size: 0.6rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                background-color: #14532d;
                color: #4ade80;
                border: 1px solid #000;
                padding: 3px 8px;
                border-radius: 99px;
                z-index: 10;
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.5);
                pointer-events: none;
            }
            /* Special positioning for email button badge */
            #email-btn .badge-last-used {
                top: -6px;
                right: -6px;
            }

            .input-group {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                position: relative;
            }
            label {
                font-size: 0.8rem;
                font-weight: 500;
                color: var(--text-secondary);
            }
            input {
                height: 2.75rem;
                width: 100%;
                border-radius: 8px;
                border: 1px solid var(--border-color);
                background-color: #0f0f0f;
                padding: 0 1rem;
                font-size: 0.875rem;
                color: var(--text-primary);
                outline: none;
                transition:
                    border-color 0.2s,
                    box-shadow 0.2s;
            }
            input:focus {
                border-color: #52525b;
                background-color: #000;
            }

            .divider {
                position: relative;
                text-align: center;
                font-size: 0.75rem;
                color: var(--text-muted);
                margin: 1.25rem 0;
            }
            .divider::before {
                content: "";
                position: absolute;
                top: 50%;
                left: 0;
                width: 100%;
                height: 1px;
                background: var(--border-color);
            }
            .divider span {
                position: relative;
                background: var(--bg-card);
                padding: 0 0.75rem;
                text-transform: uppercase;
                font-weight: 600;
            }
            .icon {
                width: 1.1rem;
                height: 1.1rem;
            }

            .alert {
                padding: 0.75rem;
                border-radius: var(--radius);
                font-size: 0.875rem;
                display: none;
                text-align: center;
                margin-bottom: 1rem;
            }
            .alert.show {
                display: block;
            }
            .alert-error {
                background: rgba(69, 10, 10, 0.4);
                border: 1px solid #7f1d1d;
                color: #fca5a5;
            }
            .alert-info {
                background: rgba(23, 37, 84, 0.4);
                border: 1px solid #1e3a8a;
                color: #93c5fd;
            }

            /* --- Terms Text --- */
            .terms-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-top: 0.25rem;
            }

            .terms-text {
                font-size: 0.7rem;
                color: #71717a;
                line-height: 1.4;
            }

            .terms-text a {
                color: #71717a;
                text-decoration: none;
                border-bottom: 1px solid #3f3f46;
                transition: all 0.15s ease;
            }

            .terms-text a:hover {
                color: #a1a1aa;
                border-color: #52525b;
            }
        </style>
    </head>
    <body>
        <div class="col-left">
            <a href="#" class="brand-corner">
                <svg
                    class="logo"
                    viewBox="0 0 1975.28 433.45"
                    xmlns="http://www.w3.org/2000/svg"
                >
                    <g fill="#fff">
                        <path
                            d="M590.64,393.66v-207.41h-50.27v-53.97h50.27V50.79h64.55v81.48h50.8v53.97h-50.8v207.41h-64.55Z"
                        />
                        <path
                            d="M728.2,40.74c0-21.69,17.46-38.63,39.68-38.63s38.63,16.93,38.63,38.63-17.46,39.15-38.63,39.15c-22.22,0-39.68-17.46-39.68-39.15ZM735.61,132.28h64.55v261.38h-64.55V132.28Z"
                        />
                        <path
                            d="M856.24,393.66V132.28h59.26l5.29,30.69c13.23-21.69,39.68-38.63,77.25-38.63,39.68,0,67.2,19.58,80.95,49.74,13.23-30.16,43.92-49.74,83.6-49.74,63.49,0,98.42,38.1,98.42,98.42v170.9h-64.02v-153.97c0-37.57-20.11-57.14-50.8-57.14s-55.03,20.1-55.03,62.96v148.15h-64.55v-154.5c0-36.51-19.58-56.09-50.27-56.09s-55.56,20.11-55.56,62.44v148.15h-64.55Z"
                        />
                        <path
                            d="M1313.91,393.66V0h64.55v170.37c16.93-29.1,51.85-46.56,91.54-46.56,74.6,0,120.11,58.2,120.11,140.74s-49.21,135.98-124.34,135.98c-39.15,0-72.49-17.46-87.83-47.62l-4.23,40.74h-59.79ZM1452.54,341.28c45.5,0,72.49-32.81,72.49-79.37s-26.98-79.9-72.49-79.9-73.55,32.81-73.55,79.9,29.1,79.37,73.55,79.37Z"
                        />
                        <path
                            d="M1619.2,319.05c0-48.15,34.92-78.31,96.83-83.07l78.31-5.82v-5.82c0-35.45-21.16-49.74-53.97-49.74-38.1,0-59.26,15.87-59.26,43.39h-55.03c0-56.61,46.56-93.65,117.46-93.65s113.76,38.1,113.76,110.59v158.73h-56.62l-4.76-38.63c-11.11,26.98-46.56,45.5-87.3,45.5-55.56,0-89.42-32.28-89.42-81.48ZM1794.86,287.83v-13.76l-54.5,4.23c-40.21,3.7-55.56,16.93-55.56,38.1,0,23.81,15.87,35.45,44.98,35.45,39.68,0,65.08-23.81,65.08-64.02Z"
                        />
                        <path d="M1911.26,393.66V0h64.02v393.66h-64.02Z" />
                        <polygon
                            points="423.21 27.58 422.6 286.37 209.68 433.45 210.03 288.38 0 433.45 .61 174.66 213.53 27.58 213.18 172.65 423.21 27.58"
                        />
                    </g>
                </svg>
            </a>

            <div class="auth-card">
                <div class="header-text">
                    <h1>Get started</h1>
                    <p>Login or create account via OAuth or Email</p>
                </div>

                <div id="error" class="alert alert-error"></div>
                <div id="info" class="alert alert-info"></div>

                <div class="field-group">
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
                        Google
                    </a>

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
                        Microsoft
                    </a>

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
                        GitHub
                    </a>

                    <div class="divider">
                        <span>or continue with</span>
                    </div>

                    <form
                        id="magic-link-form"
                        class="input-group"
                        data-provider="email"
                    >
                        <label for="email">Email</label>
                        <input
                            type="email"
                            id="email"
                            name="email"
                            placeholder="name@example.com"
                            required
                            autocomplete="email"
                        />
                        <button
                            type="submit"
                            id="email-btn"
                            class="btn btn-primary"
                        >
                            Login with Email
                        </button>
                    </form>
                    <div
                        id="email-sent"
                        class="alert alert-info"
                        style="display: none"
                    >
                        Check your inbox. We've sent you a secure sign-in link.
                    </div>

                    <div class="terms-container">
                        <span class="terms-text">
                            By using Timbal, you accept the
                            <a
                                href="https://app.timbal.ai/legal/terms-use/"
                                target="_blank"
                                >Terms</a
                            >
                            and
                            <a
                                href="https://app.timbal.ai/legal/privacy-policy/"
                                target="_blank"
                                >Privacy Policy</a
                            >
                        </span>
                    </div>
                </div>
            </div>
        </div>

        <div class="col-right" id="visual-container">
            <a href="https://docs.timbal.ai/" target="_blank" class="docs-link">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="1.5"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                    />
                </svg>
                Documentation
            </a>
            <canvas id="dot-canvas"></canvas>

            <div class="logo-slider-wrapper">
                <p class="trusted-label">Trusted by</p>
                <div class="logo-slider-container">
                    <div class="logo-track">
                        <div class="logo-set">
                            <img src="https://app.timbal.ai/logos/drivim.png" alt="Drivim" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/benito.png" alt="Benito" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/girbau.png" alt="Girbau" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/fredvic.png" alt="Fredvic" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/ferrer.png" alt="Ferrer" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/vicio.png" alt="Vicio" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/civitatis.png" alt="Civitatis" class="logo-item" />
                        </div>
                        <div class="logo-set" aria-hidden="true">
                            <img src="https://app.timbal.ai/logos/drivim.png" alt="Drivim" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/benito.png" alt="Benito" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/girbau.png" alt="Girbau" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/fredvic.png" alt="Fredvic" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/ferrer.png" alt="Ferrer" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/vicio.png" alt="Vicio" class="logo-item" />
                            <img src="https://app.timbal.ai/logos/civitatis.png" alt="Civitatis" class="logo-item" />
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            // ============================================
            // 1. OAUTH & FORM LOGIC + LOCAL STORAGE
            // ============================================
            const errorEl = document.getElementById("error");
            const urlParams = new URLSearchParams(window.location.search);
            const error = urlParams.get("error");
            const redirectUri =
                urlParams.get("redirect_uri") || window.location.href;
            const baseUrl = window.location.origin + "${prefix}";

            // Persist return_to as a short-lived cookie so it survives
            // the OAuth redirect chain (login → provider → callback).
            // Fall back to document.referrer (same-origin only) so that
            // even if a caller forgets to pass return_to, the user still
            // lands back where they came from.
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
                document.cookie = "timbal_return_to=" + encodeURIComponent(returnTo) + "; path=/; max-age=600; SameSite=Lax";
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

            // --- MAGIC LINK FORM HANDLER ---
            const magicLinkForm = document.getElementById("magic-link-form");
            const emailInput = document.getElementById("email");
            const emailBtn = document.getElementById("email-btn");
            const emailSentMsg = document.getElementById("email-sent");
            const originalBtnText = emailBtn
                ? emailBtn.innerHTML
                : "Continue with Email";

            if (magicLinkForm) {
                magicLinkForm.addEventListener("submit", async (e) => {
                    e.preventDefault();
                    const email = emailInput.value.trim();
                    if (!email) return;

                    errorEl.classList.remove("show");
                    emailInput.disabled = true;
                    emailBtn.disabled = true;
                    emailBtn.classList.add("btn-loading");
                    emailBtn.innerHTML = "Sending...";

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

            // --- LAST USED PROVIDER LOGIC ---
            (function handleLastUsedProvider() {
                const STORAGE_KEY = "timbal_last_auth_provider";
                const lastProvider = localStorage.getItem(STORAGE_KEY);

                if (lastProvider) {
                    // Handle OAuth buttons
                    const targetBtn = document.querySelector(
                        \`.track-auth[data-provider="\${lastProvider}"]\`,
                    );
                    if (targetBtn) {
                        const badge = document.createElement("span");
                        badge.className = "badge-last-used";
                        badge.innerHTML = "Last";
                        targetBtn.appendChild(badge);
                        targetBtn.style.borderColor = "#14532d";
                    }

                    // Handle email form specially
                    if (lastProvider === "email") {
                        const emailBtn = document.getElementById("email-btn");
                        if (emailBtn) {
                            const badge = document.createElement("span");
                            badge.className = "badge-last-used";
                            badge.innerHTML = "Last";
                            emailBtn.appendChild(badge);
                            emailBtn.style.borderColor = "#14532d";
                        }
                    }
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

            // ============================================
            // 2. ANIMATED CANVAS LOGIC (Pulsing Matrix)
            // ============================================
            (function initDotPattern() {
                const canvas = document.getElementById("dot-canvas");
                const container = document.getElementById("visual-container");
                if (!canvas || !container) return;

                const ctx = canvas.getContext("2d");

                // --- CONFIGURATION ---
                const config = {
                    dotSize: 2,
                    gap: 20,
                    baseColor: "#22c55e",
                    glowColor: "#86efac",
                    attractorRadius: 600,
                    waveSpeed: 0.4,
                };

                let dots = [];
                let animationId;
                let startTime = Date.now();

                const attractors = [
                    {
                        id: 1,
                        angleX: 0,
                        angleY: 0,
                        speedX: 0.0005,
                        speedY: 0.0007,
                        radiusX: 0.6,
                        radiusY: 0.6,
                    },
                    {
                        id: 2,
                        angleX: 2,
                        angleY: 1,
                        speedX: 0.0009,
                        speedY: 0.0006,
                        radiusX: 0.4,
                        radiusY: 0.7,
                    },
                    {
                        id: 3,
                        angleX: 4,
                        angleY: 3,
                        speedX: 0.0006,
                        speedY: 0.001,
                        radiusX: 0.7,
                        radiusY: 0.4,
                    },
                ];

                function hexToRgb(hex) {
                    const result =
                        /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
                    return result
                        ? {
                              r: parseInt(result[1], 16),
                              g: parseInt(result[2], 16),
                              b: parseInt(result[3], 16),
                          }
                        : { r: 0, g: 0, b: 0 };
                }

                const baseRgb = hexToRgb(config.baseColor);
                const glowRgb = hexToRgb(config.glowColor);

                function buildGrid() {
                    const rect = container.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;

                    canvas.width = rect.width * dpr;
                    canvas.height = rect.height * dpr;
                    canvas.style.width = \`\${rect.width}px\`;
                    canvas.style.height = \`\${rect.height}px\`;

                    ctx.scale(dpr, dpr);

                    const cellSize = config.dotSize + config.gap;
                    const cols = Math.ceil(rect.width / cellSize) + 2;
                    const rows = Math.ceil(rect.height / cellSize) + 2;

                    const offsetX = (rect.width - (cols - 1) * cellSize) / 2;
                    const offsetY = (rect.height - (rows - 1) * cellSize) / 2;

                    dots = [];
                    for (let row = 0; row < rows; row++) {
                        for (let col = 0; col < cols; col++) {
                            const baseX = offsetX + col * cellSize;
                            const baseY = offsetY + row * cellSize;
                            dots.push({
                                baseX: baseX,
                                baseY: baseY,
                                x: baseX,
                                y: baseY,
                                baseOpacity: 0.1 + Math.random() * 0.2,
                            });
                        }
                    }
                }

                function draw() {
                    const dpr = window.devicePixelRatio || 1;
                    ctx.clearRect(
                        0,
                        0,
                        canvas.width / dpr,
                        canvas.height / dpr,
                    );

                    const time = Date.now() - startTime;
                    const waveTime = time * 0.001 * config.waveSpeed;

                    const w = canvas.width / dpr;
                    const h = canvas.height / dpr;

                    const currentAttractors = attractors.map((attr) => {
                        return {
                            x:
                                w / 2 +
                                Math.cos(time * attr.speedX + attr.angleX) *
                                    (w * attr.radiusX),
                            y:
                                h / 2 +
                                Math.sin(time * attr.speedY + attr.angleY) *
                                    (h * attr.radiusY),
                        };
                    });

                    for (const dot of dots) {
                        const drift =
                            Math.sin(
                                dot.baseX * 0.01 + dot.baseY * 0.01 + waveTime,
                            ) * 2;
                        dot.x = dot.baseX + drift;
                        dot.y = dot.baseY + drift;

                        let totalInfluence = 0;

                        currentAttractors.forEach((attr) => {
                            const dx = dot.x - attr.x;
                            const dy = dot.y - attr.y;
                            const distSq = dx * dx + dy * dy;
                            const proxSq =
                                config.attractorRadius * config.attractorRadius;

                            if (distSq < proxSq) {
                                const dist = Math.sqrt(distSq);
                                const t = 1 - dist / config.attractorRadius;
                                const influence = t * t * (3 - 2 * t);
                                totalInfluence += influence * 0.7;
                            }
                        });

                        totalInfluence = Math.min(1, totalInfluence);

                        const r = Math.round(
                            baseRgb.r +
                                (glowRgb.r - baseRgb.r) * totalInfluence,
                        );
                        const g = Math.round(
                            baseRgb.g +
                                (glowRgb.g - baseRgb.g) * totalInfluence,
                        );
                        const b = Math.round(
                            baseRgb.b +
                                (glowRgb.b - baseRgb.b) * totalInfluence,
                        );

                        const waveOpacity =
                            dot.baseOpacity +
                            Math.sin(dot.x * 0.02 + waveTime) * 0.1;
                        const opacity = Math.min(
                            1,
                            waveOpacity + totalInfluence * 0.8,
                        );

                        const radius = config.dotSize / 2;

                        ctx.beginPath();
                        ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
                        ctx.fillStyle = \`rgba(\${r}, \${g}, \${b}, \${opacity})\`;
                        ctx.fill();
                    }

                    animationId = requestAnimationFrame(draw);
                }

                window.addEventListener("resize", buildGrid);
                window.addEventListener("load", function () {
                    buildGrid();
                    animationId = requestAnimationFrame(draw);
                });
            })();
        </script>
    </body>
</html>
`;
}
