// Controlled browser navigation for the built CLI's loopback OAuth test.
if (process.env.OAUTH_BROWSER_FAIL === "1") process.exit(7);
const response = await fetch(process.argv.at(-1));
if (response.status !== 200) throw new Error(`Callback failed (${response.status}).`);
