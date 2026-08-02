// sms — one text, from Etta's own number.
//
// Everything the family receives arrives here: the senior needs no app, and
// neither does the family. Without the TWILIO_* secrets this is a no-op that
// returns false, so callers can record "not delivered" rather than pretend.

const DEFAULT_FROM_NUMBER = "+17622394275"; // the number Etta also calls from

/** Sends one SMS per recipient. True only if every send succeeded. */
export async function sendText(to: string[], body: string): Promise<boolean> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? DEFAULT_FROM_NUMBER;
  if (!sid || !token || to.length === 0) return false;

  let allOk = true;
  for (const number of to) {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: number, Body: body }),
      },
    );
    if (!res.ok) {
      console.error("twilio sms failed:", number, res.status, await res.text());
      allOk = false;
    }
  }
  return allOk;
}
