// `fake-github.mjs` exports nothing. Importing it replaces `globalThis.fetch`
// for api.github.com and github.com with the synthetic Github, and it reads
// FAKE_GH_LOG and FAKE_ORGS as it loads, so a caller sets those first.
export {};
