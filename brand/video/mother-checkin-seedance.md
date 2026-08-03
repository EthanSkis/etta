# "Seven in the morning" — Seedance 2.0 brand film

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
| Resolution / mode | 720p / `std` — 67.5 credits. 1080p is 135. |
| Genre | `drama` |
| `generate_audio` | `true` (ambient only; the prompt forbids music and dialogue) |
| Reference media | `image_references` × 2 — see below |
| Plan | **Requires Higgsfield Plus or Ultra.** Starter returns `403: "Pro" or "Ultimate" plan required`. |

### Reference media

Both are real assets, not mockups — the point of the shot is that the thing on
the screen is the thing the product actually sends.

1. `brand/video/etta-text-message-screen.png` — the family summary text on an
   iOS Messages thread. Copy mirrors the family-note template in
   `supabase/functions/call-events/index.ts` (signal emoji, mood word, call
   length, the `😴 · 🥣 · 💊 · Mood` chip row, the summary, "Keeping an eye
   on:", the share link, the `— Etta` signature and the A2P 10DLC opt-out
   line). Regenerate with `make-text-message-screen.js`.
2. `brand/etta-mark-light-512.png` — the mark, also embedded in the above as
   the contact avatar.

### Note on the preset recommendation

Higgsfield's MCP may intercept this prompt and suggest the "IN THE DARK"
preset. Decline it — it replaces the brief with a canned moody look and drops
Seedance. Retry with `declined_preset_id: "24bae836-2c4a-48e0-89b6-49fcc0b21612"`.

## Prompt

```text
Main subject: An American woman in her late forties, ordinary and unstyled.
Shoulder-length dark brown hair with a few greys at the temples, loosely tucked
behind one ear, slightly unbrushed. Fine lines around tired kind eyes, no
makeup, realistic skin texture with visible pores and faint under-eye shadows.
Oatmeal-coloured knit cardigan over a plain white t-shirt, thin gold wedding
band, no other jewellery. Holding a modern black smartphone. Maintain
consistent identity, clothing, hairstyle and appearance throughout the entire
video.

Location: Her own quiet suburban kitchen at 7am, before anyone else is awake.
Worn wooden counter, a single ceramic mug of coffee going cold, a folded dish
towel, a small potted herb on the windowsill. Soft low-angle morning sun
through a window with thin curtains, dust motes in the light beam, warm shadows
across the counter. A corkboard with old family photographs slightly out of
focus in the background. No television, no other people, no pets, no clutter,
no signage.

Visual Style: Ultra-realistic intimate documentary. Warm natural window light
only, no artificial fill. Shallow depth of field, gentle film grain, soft
highlight rolloff, muted warm palette of cream, oat, and terracotta. Genuine
unperformed emotion held in small physical detail — breath, jaw, shoulders, the
corners of the eyes. No melodrama, no crying-for-camera, no acting beats.

Camera Style: Quiet observational handheld. A camera that is close but never
intrusive. Subtle breathing movement, small natural drift, slow deliberate
reframing, one gentle push-in during the reading moment. No gimbal glide, no
drone, no whip pans, no zoom punches, no stabilization sheen.

00:00–00:03
Medium shot. She stands alone at the counter, both hands wrapped around the
cold mug, staring at nothing. The house is completely still. Her phone lies
face-down beside her. She is not doing anything — she is worrying. Her thumb
taps the mug once, unconsciously.

00:03–00:06
She turns the phone over, opens it, and her thumb hovers over a contact simply
named Mom. She holds it there. She does not press it. A long breath out, eyes
closing briefly, and she sets the phone back down on the counter and presses
her fingertips to her forehead. The camera stays with her, slightly too long.

00:06–00:08
A single short vibration rattles the phone against the wooden counter. Her head
turns down toward it fast — a flash of fear before anything else. She picks it
up with both hands.

00:08–00:11
Tight over-the-shoulder insert of the phone screen filling most of the frame,
held steady and in sharp focus. The screen shows EXACTLY the referenced
text-message screenshot, reproduced faithfully and legibly: the cream circular
Etta logo avatar with a dark lowercase letter e and a small terracotta dot at
the top of the thread, the contact name Etta beneath it, and a grey message
bubble beginning with a green circle and the words Etta's check-in with
Margaret. Her thumb scrolls the message down a little as she reads. The text
remains crisp, correctly spelled, and unwarped throughout — do not invent,
replace, or garble any words on the screen.

00:11–00:13
Cut to her face, phone still raised, reading. The change is small and
involuntary: her jaw unclenches, her shoulders drop a full inch, her eyes go
glassy and she blinks it back. A breath she has been holding all morning
finally leaves her.

00:13–00:15
She lowers the phone and holds it lightly against her chest, closes her eyes,
and a small real smile arrives — relief, not joy. Morning light crosses her
face. She opens her eyes and looks toward the window. Hold, then a soft cut to
black.

Audio: Natural ambient sound only — the low hum of a refrigerator, faint birds
outside, one short phone vibration buzzing against wood, the ceramic mug
settling, her breathing in and out, the quiet rustle of knit fabric, distant
early-morning street tone. No music. No dialogue. No narration. No sound design
flourishes.

Negative: no text overlays, no captions, no subtitles, no watermarks, no logos
anywhere except the Etta logo on the phone screen, no other brands, no second
person entering frame, no phone call being answered, no smiling at the camera.
```

## Why these choices

**The problem shot comes first.** Ten of the fifteen seconds are the worry —
the cold coffee, the contact she opens and doesn't call. That hesitation is the
business: calling every day yourself is unsustainable, and not calling costs
you the morning. Leading with the product would make it an ad for a texting
service.

**The screen is a real send, not a prop.** The bubble is the actual family-note
format, opt-out line and all. A viewer who signs up gets this exact text, which
is the only version of this shot that survives contact with a customer.

**The green signal does the work.** The family note opens with a colour that
reads from the lock screen — 🟢 here, and 🔴 reserved for "needs attention."
The film is built so the relief lands on that first character, before she has
read a word.

**The watch item stays in.** The message says the knee is stiffer on stairs.
Trimming it to pure good news would sell a product that only ever reassures;
the flag is what makes the reassurance worth anything.

**No music, no voiceover.** Every competitor in this category advertises with
strings and a narrator. Silence and room tone is the same posture as the
product itself: honest about what it is, not performing warmth at you.
