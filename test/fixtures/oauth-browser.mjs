// Controlled browser navigation for the built CLI's loopback OAuth tests: opens the authorization
// URL, answers the daemon's consent page as an operator would ({§agui-oauth-session}), and follows
// the redirect to the client's loopback callback.
if (process.env.OAUTH_BROWSER_FAIL === "1") process.exit(7);
const url = process.argv.at(-1);
const first = await fetch(url, { redirect: "manual" });
let callback = first.headers.get("location");
if (first.status === 200 && callback === null) {
    const page = await first.text();
    if (!page.includes('name="consent"')) throw new Error("The authorization page is neither a redirect nor a consent page.");
    const fields = new URLSearchParams();
    for (const [, name, value] of page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) {
        fields.set(name, value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&#39;", "'"));
    }
    fields.set("consent", "allow");
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const consented = await fetch(new URL("/oauth/authorize", url), {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        body: fields.toString(),
    });
    callback = consented.headers.get("location");
    if (consented.status !== 302 || callback === null) throw new Error(`Consent was not accepted (${consented.status}).`);
} else if (first.status !== 302 || callback === null) {
    throw new Error(`Authorization failed (${first.status}).`);
}
const response = await fetch(callback);
if (response.status !== 200) throw new Error(`Callback failed (${response.status}).`);
