# CDG Ops App — Build & Design Standard

## Goal
Every screen should look and feel like a finished, professional CDG product. Clean, consistent, nothing that looks thrown together.

## Look
- CDG black / orange / white. One black, one orange, one red (alerts only). Defined once as color variables, never hard-coded.
- One font family. Fixed text sizes: page title, section title, body, small. Body text at least 16px on phones, 18px on tablets.
- Fixed spacing steps (4 / 8 / 16 / 24 / 32px). No random gaps.
- Rounded corners, borders, and shadows the same everywhere.

## Build once, reuse everywhere
- One version each of: primary button (orange), secondary button (outline), danger button/banner (red), card, filter chip, banner, form field, toast.
- New screens use these parts. No one-off styling.

## Shop floor usability
- Tap targets at least 56px tall (gloves).
- High contrast, readable at arm's length on a tablet.
- Icons always paired with words.
- Two taps to anything.
- Plain language: "Line 3 is down," not "Asset status: inactive." Consistent capitalization.

## Every screen must handle
- Loading (skeleton or spinner, never a blank screen)
- Empty (explains what goes here and what to do)
- Error (plain-language message + retry)
- Offline (shows it's offline; saves sync later)
- Success (clear confirmation after every save or sign-off)

## Feel
- Every tap gives instant visual feedback.
- Animations subtle and quick (about 150–200ms). Nothing flashy.
- Nothing jumps or shifts as the page loads.

## Never ship
- Placeholder text, "lorem ipsum," test data, debug messages, or console errors
- Misaligned elements or text that overflows or gets cut off
- Anything that only works on one screen size

## Done means
1. Check every changed screen at phone (375px), tablet (1024px), and desktop widths.
2. Self-review against this file and fix anything that misses.
3. Then show Chris screenshots and the dev test link.
