### fix(auth): the sign-in link carries its token in the URL fragment

The emailed link is now `/auth/email/callback#token=...`. A browser never sends the fragment, so the token no longer appears in a request line or a request log. The confirm page is static and never reads a query string. `public/auth-callback.js` moves the token into the confirm form and strips it from the address bar, and only the form POST spends it, as before (single-use, 15 minutes).

Deploy note: a link mailed in the 15 minutes before the deploy opens a page that says the link is incomplete; ask for a new one.
