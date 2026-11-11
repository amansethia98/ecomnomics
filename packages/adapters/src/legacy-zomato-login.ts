/** The pre-sync Zomato flow used an owner chat reply, not a private-code card. */
export const LEGACY_ZOMATO_LOGIN_ORIGINS = new Set([
  "https://accounts.zomato.com",
  "https://www.zomato.com",
  "https://zomato.com",
]);

export const LEGACY_ZOMATO_LOGIN_GUIDANCE =
  "Zomato sign-in is the compatibility exception: only for an explicitly authorized sign-in on accounts.zomato.com, use the pre-sync owner-code reply flow, not request_secret oneTimeCode or fill_code. Request one emailed code through the visible login page, then ask the owner for that code and wait for their normal reply (an authorized coordinator may obtain it from the inbox). Take a fresh browser_snapshot, and use ordinary browser_act type, not fill. For the six visible boxes, use one batch of six ordinary type actions, one character on each fresh box ref in order; do not type the whole code into the first maxlength=2 field. Then separately click the visible Continue control once if the page has not already signed in and verify the signed-in page. Never repeat a code, request a resend, use a password or Google sign-in, or include the code in narration, files or shell commands. Do not authenticate during reconciliation unless the owner separately authorized sign-in.";

export const LEGACY_ZOMATO_LOGIN_HINT =
  "Zomato auth: owner code reply, six ordinary type actions then Continue; never fill_code. Follow the Zomato login skill.";
