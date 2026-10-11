# Privacy policy for the Phonemos app for YouTrack

This notice describes how the Phonemos app for YouTrack processes personal data. It applies only to that app.

The general Phonemos privacy policy covers the Phonemos websites, mail campaigns, and related services. It does not cover this app. That policy is published at [Datenschutzbestimmungen](https://wiki.linkyard.cloud/t/0GZPGlFvTqWz9iCCcJtJ2Q/w/GGUEXWYIT3KZ5gKYQ7HfJQ). Controller contact details, data-subject rights, the right to object, and the security measures described there also apply here.

## 1 Controller and roles

The app publisher is:

Phonemos GmbH, Junkerngasse 39, 3011 Bern, Switzerland  
Email: [dpo@phonemos.com](mailto:dpo@phonemos.com)

Phonemos GmbH does not operate the YouTrack site on which the app is installed, and it does not choose which Phonemos site the app talks to. The organisation that installs the app (the YouTrack administrator) configures the Phonemos base URL, the OAuth client, and the search root.

- For ticket content and the identity of YouTrack users, that organisation is the controller. Phonemos GmbH is the author of the app, not the controller of that content.
- When the configured Phonemos site is Phonemos Cloud operated by Phonemos GmbH, the customer remains the controller and Phonemos GmbH processes the data as a processor under the [Data Processing Agreement](https://doc.phonemos.com/guide/da97d1f8-d8b0-4015-a903-9f99fc8fd7f8).
- When the configured Phonemos site is operated by the customer or by another provider, that operator receives the data. Phonemos GmbH does not.

## 2 What the app processes

The app runs inside YouTrack. It does not run on a Phonemos GmbH server, and it does not send usage statistics to Phonemos GmbH.

After a user chooses **Connect to Phonemos**, the app does the following.

**Sign-in.** The app starts an OAuth 2.0 authorisation-code flow with PKCE against the Keycloak identity provider configured by the YouTrack administrator. YouTrack stores, for that user, the access token, the refresh token if one is issued, and the expiry time. The app uses these tokens only to call the configured Phonemos site as that user. Disconnecting removes the stored tokens.

**Search.** While the user is connected, opening a ticket sends a search query to the configured Phonemos site. The query is built from that ticket’s summary, description, and the latest comment written by the reporter. Markup is stripped. The query is limited in length. The request also includes the configured search-root object and a result limit. Phonemos applies that user’s own permissions and returns matching pages (title, extract, and link). The app does not write those results back to Phonemos.

The app does not sell personal data and does not use ticket content for advertising, training, or product analytics.

## 3 Legal basis

Where the customer is the controller, the customer determines the legal basis for using the app on its YouTrack site. Typical bases are Art. 6 (1) (b) GDPR (performance of a contract with the people whose tickets are handled) and Art. 6 (1) (f) GDPR (legitimate interest in resolving requests with the existing knowledge base).

Sign-in is started by the user. The app does not search Phonemos until that user has connected.

## 4 Recipients and transfers

The only recipient of ticket text and of the OAuth token is the Phonemos site named in the app settings. That transfer uses HTTPS.

No other processor is added by the app. Hosting, subprocessors, and international transfers for a Phonemos Cloud site are those already described in the Phonemos privacy policy and the Data Processing Agreement. A self-hosted Phonemos site is governed by its own operator.

## 5 Retention

OAuth tokens remain in the customer’s YouTrack until the user disconnects, an administrator removes the app, or the tokens are replaced on refresh. The app does not keep a copy of search queries after the request to Phonemos completes. Retention of content inside Phonemos is governed by that Phonemos site, not by this app.

## 6 Your rights

The rights in section 7 of the [general Phonemos privacy policy](https://wiki.linkyard.cloud/t/0GZPGlFvTqWz9iCCcJtJ2Q/w/GGUEXWYIT3KZ5gKYQ7HfJQ) apply, including access, rectification, erasure, restriction, portability, objection, and the right to lodge a complaint with a supervisory authority.

For data in a customer’s YouTrack or in a Phonemos site the customer operates, contact that organisation first. For Phonemos Cloud, contact [dpo@phonemos.com](mailto:dpo@phonemos.com). The objection address in the general policy is support@linkyard.ch.

## 7 Changes

This notice was first published in October 2026. Phonemos GmbH will update it when the app’s processing changes.
