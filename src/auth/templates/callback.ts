/**
 * Renders the OAuth callback page.
 * @param prefix - Route prefix ("" or "/api")
 * @param afterLoginRedirect - Where to redirect after successful login
 */
export function renderCallbackPage(prefix: string, afterLoginRedirect: string): string {
  return `
<!doctype html>
<html>
    <head>
        <title>Authenticating...</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link
            rel="icon"
            type="image/png"
            href="https://content.timbal.ai/assets/favicon.png"
        />
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            body {
                font-family:
                    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                    sans-serif;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #0a0a0a;
                color: #fafafa;
            }
            .container {
                text-align: center;
                padding: 2rem;
            }
            .spinner {
                width: 40px;
                height: 40px;
                border: 3px solid #27272a;
                border-top-color: #3b82f6;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 1rem;
            }
            @keyframes spin {
                to {
                    transform: rotate(360deg);
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="spinner"></div>
            <p>Completing authentication...</p>
        </div>

        <script>
            function showError(code) {
                localStorage.removeItem("timbal_project_access_token");
                localStorage.removeItem("timbal_project_refresh_token");
                window.location.replace(
                    "${prefix}/auth/login?error=" + (code || "auth_failed"),
                );
            }

            // Extract tokens from URL hash fragment
            const hash = window.location.hash.substring(1);
            if (!hash) {
                showError("no_tokens");
            } else {
                const params = new URLSearchParams(hash);
                const access_token = params.get("access_token");
                const refresh_token = params.get("refresh_token");

                if (!access_token || !refresh_token) {
                    showError("no_tokens");
                } else {
                    // Store tokens in localStorage
                    localStorage.setItem("timbal_project_access_token", access_token);
                    localStorage.setItem("timbal_project_refresh_token", refresh_token);

                    // Validate token with the server
                    fetch("${prefix}/auth/set-token", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": "Bearer " + access_token,
                        },
                        body: JSON.stringify({ access_token }),
                    })
                        .then(async (res) => {
                            if (res.ok) {
                                const savedReturn = sessionStorage.getItem("timbal_return_to");
                                sessionStorage.removeItem("timbal_return_to");
                                window.location.replace(savedReturn || "${afterLoginRedirect}");
                            } else if (res.status === 401) {
                                showError("invalid_token");
                            } else {
                                showError("auth_failed");
                            }
                        })
                        .catch(() => showError("auth_failed"));
                }
            }
        </script>
    </body>
</html>
`;
}
