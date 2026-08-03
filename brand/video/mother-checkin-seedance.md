# "Seven in the morning" — Seedance 2.0 brand film

## The films

| File | Job ID | Notes |
|---|---|---|
| `etta-mother-checkin-15s-9x16.mp4` | `b46652b1-e00e-4d35-a023-560204884d07` | **Primary.** Dark-haired lead, warm kitchen, best final beat. Screen renders `ETTA` and the headline correctly. |
| `etta-mother-checkin-15s-9x16-alt.mp4` | `fea9cb28-4aa2-41d3-a772-c794896137e5` | Alternate. Blonde lead, cooler white kitchen; stronger hand-to-forehead worry beat at 0:04. |

Both 1080×1920, 24fps, 15.09s, AAC ambient audio (mean −38.8 dB — room tone, no
music, as briefed).


A 15-second vertical film that puts the problem on screen before it puts the
product on screen. The buyer is the adult daughter, so she is the one we
follow: the worry, the phone she doesn't call, the text that answers the
question she was afraid to ask.

Nothing is explained and nobody speaks. The whole argument is in one face
before the text and the same face after it.

## Production settings

| | |
|---|---|
| Model | `seedance_2_0` (Higgsfield MCP `generate_video`) |
| Duration | 15s |
| Aspect ratio | 9:16 |
| Resolution / mode | 1080p / `std` — 135 credits per take (720p is 67.5). |
| Genre | `drama` |
| `generate_audio` | `true` (ambient only; the prompt forbids music and dialogue) |
| Reference media | `image_references` × 2 — see below |
| Plan | **Requires Higgsfield Plus or Ultra.** Starter returns `403: "Pro" or "Ultimate" plan required`. |

### Reference media

Real assets, not mockups — the point of the shot is that the thing on the
screen is the thing the product actually sends.

1. `brand/video/etta-lockscreen-notification.png` — **use this one for
   generated video.** One check-in arriving as a single lock-screen banner:
   the mark as the app icon, the word ETTA, and one line — the green signal
   plus "Margaret sounded bright today." Regenerate with
   `make-lockscreen-notification.js`.
2. `brand/etta-mark-light-512.png` — the mark on its own.
3. `brand/video/etta-text-message-screen.png` — the full family summary on an
   iOS Messages thread, mirroring the template in
   `supabase/functions/call-events/index.ts` (signal emoji, mood word, call
   length, the `😴 · 🥣 · 💊 · Mood` chip row, the summary, "Keeping an eye
   on:", the share link, the `— Etta` signature and the A2P 10DLC opt-out
   line). Regenerate with `make-text-message-screen.js`. **Stills and web
   only** — see below.

### Why the thread asset can't be the one on screen

The first pass fed the full Messages thread as the reference. The model
reproduced the mark faithfully — cream disc, dark `e`, terracotta dot — and
then garbled every word around it: the thread header came back as **"Ette"**,
the recipient as **"Margant"**, and the body as convincing-looking nonsense.

That is not a prompt that needs tightening. Generative video draws text as
texture, and the failure scales with how much of it there is; a paragraph will
always come back wrong, and a misspelled brand name on screen is worse than no
text at all.

So the on-screen asset for any generated shot is the one-line notification. It
is still a true send — the green signal and the mood word are exactly what the
family note leads with — and at five words the model has a real chance of
spelling it. It is also better filmmaking: nobody reads a paragraph in a
three-second insert.

If a future cut genuinely needs the full thread legible on a phone, the way to
get it is compositing the PNG onto a tracked screen in post, not asking a model
for it.

### Note on the preset recommendation

Higgsfield's MCP may intercept this prompt and suggest the "IN THE DARK"
preset. Decline it — it replaces the brief with a canned moody look and drops
Seedance. Retry with `declined_preset_id: "24bae836-2c4a-48e0-89b6-49fcc0b21612"`.

## Prompt

The casting language is blunt on purpose. An earlier pass that asked for
"late forties" returned a woman in her seventies — which reads as Margaret
rather than Margaret's daughter and inverts the premise — so age and hair
colour are now stated flatly and repeated in the negatives.

```text
Main subject: A woman who is clearly 46 years old — middle-aged, NOT elderly
and NOT a senior. Thick DARK BROWN hair, shoulder length, no grey and no white
and no blonde hair anywhere. Smooth firm skin with only fine expression lines
around the eyes; a young-looking healthy face, no jowls, no deep wrinkles, no
age spots. She is the adult daughter in this story, not the grandmother. No
makeup, realistic skin texture and pores. Oatmeal knit cardigan over a plain
white t-shirt, thin gold wedding band. Maintain this same identity, age, hair
colour, clothing and appearance in every single shot.

Location: Her own quiet suburban kitchen at 7am, before anyone else is awake.
Worn wooden counter, a ceramic mug of coffee going cold, a folded dish towel, a
potted herb on the windowsill. Soft low morning sun through a curtained window,
dust in the light, warm shadows. A corkboard of old family photographs soft in
the background. No other people, no pets, no signage.

Visual Style: Ultra-realistic intimate documentary. Warm natural window light
only. Shallow depth of field, gentle film grain, muted warm palette of cream,
oat and terracotta. Genuine unperformed emotion held in breath, jaw and
shoulders. No melodrama, no crying for camera.

Camera Style: Quiet observational handheld, close but never intrusive. Subtle
breathing movement, small natural drift, one slow push-in on the reading
moment. No gimbal glide, no drone, no whip pans, no zoom punches.

00:00–00:03
Medium shot. The 46-year-old dark-haired woman stands alone at the counter,
both hands around the cold mug, staring at nothing. The house is still. Her
phone lies face-down beside her. She is not doing anything — she is worrying.

00:03–00:06
She turns the phone over, opens it, and her thumb hovers over one contact. She
holds it there. She does not press it. A long breath out, and she sets the
phone back down and presses her fingertips to her forehead.

00:06–00:08
One short vibration rattles the phone against the wooden counter. Her head
turns down fast — a flash of fear before anything else. She picks it up.

00:08–00:11
Insert shot of the phone screen. The phone is held completely still, flat and
square to the camera, screen parallel to the lens with no tilt and no
perspective skew, filling the centre of the frame in sharp focus. The screen is
a dark warm-brown lock screen exactly matching the reference image: a large
white clock reading 7:04 near the top, and one pale rounded notification card
below it. The card contains the cream Etta app icon with a dark lowercase
letter e and a small orange dot, then the single word ETTA in small capitals,
then one short line of black text: a green dot followed by the words Margaret
sounded bright today. Those are the ONLY words anywhere on the screen. Render
them large, crisp, high-contrast and correctly spelled — ETTA spelled E-T-T-A
and Margaret spelled M-A-R-G-A-R-E-T. Do not add any other text, do not add
message bubbles, do not add paragraphs, do not invent extra lines.

00:11–00:13
Cut to her face, phone still raised, reading. The change is small and
involuntary: her jaw unclenches, her shoulders drop, her eyes go glassy and she
blinks it back. A breath she has been holding all morning finally leaves her.

00:13–00:15
She lowers the phone and holds it against her chest, closes her eyes, and a
small real smile arrives — relief, not joy. Morning light crosses her face. She
opens her eyes toward the window. Hold, then a soft cut to black.

Audio: Natural ambient sound only — refrigerator hum, faint birds outside, one
short phone vibration against wood, the mug settling, her breathing, knit
fabric, distant early-morning street tone. No music. No dialogue. No narration.

Negative: no elderly woman, no grey hair, no white hair, no senior citizen as
the main subject, no text overlays, no captions, no subtitles, no watermarks,
no paragraphs of text on the phone, no logos except the Etta icon, no second
person in frame, no phone call being answered.
```

## Why these choices

**The problem shot comes first.** Ten of the fifteen seconds are the worry —
the cold coffee, the contact she opens and doesn't call. That hesitation is the
business: calling every day yourself is unsustainable, and not calling costs
you the morning. Leading with the product would make it an ad for a texting
service.

**The screen is a real send, not a prop.** The banner carries the green signal
and the mood word the family note actually leads with, from the real mark. A
viewer who signs up gets this, which is the only version of the shot that
survives contact with a customer.

**The green signal does the work.** The family note opens with a colour that
reads from the lock screen — 🟢 here, and 🔴 reserved for "needs attention."
The film is built so the relief lands on that dot, before she has read a word.

**What the one-liner gives up.** The full note also carries the chip row and
the watch item — "left knee stiffer on stairs" — and that flag is what makes
the reassurance worth anything: a product that only ever says good news isn't
worth paying for. The banner cut can't hold it. If this film is the top of a
sequence, the piece after it should be the one that shows the whole note, on a
composited screen rather than a generated one.

**No music, no voiceover.** Every competitor in this category advertises with
strings and a narrator. Silence and room tone is the same posture as the
product itself: honest about what it is, not performing warmth at you.
