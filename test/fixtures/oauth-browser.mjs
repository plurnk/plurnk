// Controlled browser navigation for the built CLI's loopback OAuth tests: opens the authorization
// URL, signs in at the daemon's sign-in page as the operator would ({§agui-oauth-login}) with
// OAUTH_BROWSER_USER and OAUTH_BROWSER_PASS, and follows the redirect to the client's loopback callback.
if (process.env.OAUTH_BROWSER_FAIL === "1") process.exit(7);
const url = process.argv.at(-1);
const first = await fetch(url, { redirect: "manual" });
let callback = first.headers.get("location");
if (first.status === 200 && callback === null) {
    const page = await first.text();
    if (!page.includes('name="password"')) throw new Error("The authorization page is neither a redirect nor the sign-in form.");
    const fields = new URLSearchParams();
    for (const [, name, value] of page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) {
        fields.set(name, value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#39;", "'"));
    }
    fields.set("username", process.env.OAUTH_BROWSER_USER ?? "");
    fields.set("password", process.env.OAUTH_BROWSER_PASS ?? "");
    const signedIn = await fetch(new URL("/oauth/authorize", url), {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: fields.toString(),
    });
    callback = signedIn.headers.get("location");
    if (signedIn.status !== 302 || callback === null) throw new Error(`The sign-in was not accepted (${signedIn.status}).`);
} else if (first.status !== 302 || callback === null) {
    throw new Error(`Authorization failed (${first.status}).`);
}
const response = await fetch(callback);
if (response.status !== 200) throw new Error(`Callback failed (${response.status}).`);
