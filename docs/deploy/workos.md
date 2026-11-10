# Sign-in with WorkOS

Launchworks signs people in through WorkOS AuthKit (email, Google, Microsoft, and later each
customer's own SSO), beside GitHub for Icreon's operators. Only people with an invitation get in;
see [Organizations, roles and licensing](../architecture/multi-tenancy.md#sign-in-step-4).

## 1. In the WorkOS dashboard

Use one WorkOS environment, Staging or Production, for all of this. Its API key starts `sk_test_`
on Staging and `sk_live_` on Production, and its client ID must come from the same environment.

1. **Redirects**
   - Redirect URI: `https://launchworks-one.vercel.app/auth/workos/callback` (make it the default).
   - Sign-in endpoint (where invitation links and AuthKit send people to start sign-in):
     `https://launchworks-one.vercel.app/auth/login?provider=workos`
   - Sign-out redirect: `https://launchworks-one.vercel.app`
2. **Authentication**: turn on the ways in you want: email (password or magic link), Google,
   Microsoft. If your plan lets you turn off open sign-up, do; Launchworks turns away anyone
   without an invitation either way.
3. **API keys**: copy the **client ID** (`client_…`). It isn't a secret.

## 2. In Vercel (project `launchworks`, Production)

| Variable           | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| `WORKOS_KEY`       | The API key, as a Sensitive variable (already set).          |
| `WORKOS_CLIENT_ID` | The client ID from step 1.                                   |
| `AUTH`             | Keep `github`: GitHub stays for operators, WorkOS is added.  |

Redeploy. The API logs `Sign-in: WorkOS AuthKit is on.` at start.

## 3. Check it

1. Open the Control Center signed in with GitHub, then **Settings → People**, and invite your own
   email as a Director of Icreon. WorkOS sends the email.
2. In a private window, follow the link. AuthKit signs you up; you land in the Control Center as
   that address, in Icreon.
3. Sign out and open the app again: the sign-in page offers both ways in.

If someone sees "hasn't been invited yet", their invitation expired (7 days), was withdrawn, or
went to another address: invite them again from People.
