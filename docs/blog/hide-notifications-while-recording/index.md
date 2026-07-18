# Hide notifications while screen recording, on every OS

July 18, 2026 · Screen Recording · 7 min read · https://aidemo.top/blog/hide-notifications-while-recording/

> A toast doesn't live in your window; the OS paints it on top. Do Not Disturb on every OS, why it still leaks, and where a notification can't fire.

**Key takeaways**

- An OS notification is drawn by the compositor on top of every window, so a full-screen or full-window capture films it; only Do Not Disturb or a surface it cannot reach prevents the leak.
- Do Not Disturb by OS: macOS Option-click the menu-bar clock (or Control Center), Windows the bell-with-zZ in the notification center, GNOME the toggle at the bottom of the notification list.
- Do Not Disturb is a policy filter, not a mute: macOS still shows time-sensitive and allowed apps, Windows shows priority notifications and alarms, GNOME shows critical alerts like low battery.
- Windows 11 can auto-enable Do Not Disturb "When duplicating the display" — the presenting-and-recording case — so a public take never depends on you remembering the switch.
- Isolation ladder for a zero-leak recording: DND, then a clean profile with notification permission denied, then a scoped tab or window, then a headless environment with no notification daemon at all.

## A notification is painted on top of your recording, not inside it

An operating-system notification is not part of any window. The compositor draws it in its own layer above everything on screen, at the moment the sending app decides, which is why one can slide into a recording that has nothing to do with the app that sent it. A full-screen or full-window capture films the whole compositor output, banner and all. MDN describes the web version of the same object exactly: a notification is "rendered by the operating system's native notification system" and sits "outside the top-level browsing context viewport," so it "can be shown even when the user has switched tabs or moved to a different app" ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)). Read that as the general rule. The notification layer is above whatever you are recording, so there are only two honest defenses: stop the notifications from firing, or record a surface the layer cannot reach.

That splits the job in two, and most guides stop after the first half. Move one is telling the OS to hold notifications with Do Not Disturb. Move two, for any recording that must never leak a customer name or an unshipped feature, is recording where a toast has nowhere to land. This is the notifications half of [the capture-quality checklist](/blog/how-to-record-your-screen-in-high-quality), which lists a leaked toast among the few mistakes no filter fixes after the fact, because it is baked into the pixels the instant it appears.

## Do Not Disturb on macOS, Windows, and Linux, in one table

Every desktop OS ships the same primitive under a different name and a different switch. Here is where each one lives, with the single non-obvious detail per platform.

| OS | Where the switch is | The detail worth knowing |
|---|---|---|
| macOS (Do Not Disturb Focus) | Control Center, click the Focus section, then Do Not Disturb ([Apple Support, 2026](https://support.apple.com/guide/mac-help/turn-a-focus-on-or-off-mchl999b7c1a/mac)) | Fastest path is "pressing and holding the Option key while you click the date and time in the menu bar" |
| Windows 11 | Notification center, the bell icon marked zZ ([Microsoft Support, 2026](https://support.microsoft.com/en-us/windows/change-notification-settings-in-windows-8942c744-6198-fe56-4639-34320cf9444e)) | It can turn on automatically "When duplicating the display" — exactly the present-and-record case |
| Linux (GNOME) | Open the notification list, switch Do Not Disturb on at the bottom ([GNOME, 2026](https://help.gnome.org/users/gnome-help/stable/shell-notifications.html.en)) | No record-aware trigger; it is a manual toggle you flip each session |

The Windows automatic trigger is the one actually worth configuring. Windows 11 will enable Do Not Disturb on its own "When duplicating the display," "When playing a game," or "When using an app in full-screen mode," so a presentation or a full-screen capture goes quiet without you remembering ([Microsoft Support, 2026](https://support.microsoft.com/en-us/windows/change-notification-settings-in-windows-8942c744-6198-fe56-4639-34320cf9444e)). macOS supports schedules but has no built-in "while recording" rule, and GNOME has neither. On those two, your muscle memory is the trigger, which is exactly the trigger that fails on the take that matters.

## What Do Not Disturb still lets through

Here is the fact the one-line guides skip: Do Not Disturb is a policy filter, not a hard mute. Every OS ships deliberate exceptions, and each one is a hole a demo can fall through.

| OS | What still pops while Do Not Disturb is on |
|---|---|
| macOS | Time-sensitive notifications, plus any Allowed People and Allowed Apps you configured, and phone calls ([Apple Support, 2026](https://support.apple.com/guide/mac-help/set-up-a-focus-to-stay-on-task-mchl613dc43f/mac)) |
| Windows 11 | Priority notifications — incoming calls, reminders, and allowlisted apps — plus alarms ([Microsoft Support, 2026](https://support.microsoft.com/en-us/windows/change-notification-settings-in-windows-8942c744-6198-fe56-4639-34320cf9444e)) |
| GNOME | "only very important notifications, such as when your battery is critically low, will pop up" ([GNOME, 2026](https://help.gnome.org/users/gnome-help/stable/shell-notifications.html.en)) |

The macOS row is the trap. Apple frames a Focus as the place where "you can specify which notifications are shown when a Focus is active — for example, notifications from certain people and apps, time-sensitive notifications, or notifications for phone calls" ([Apple Support, 2026](https://support.apple.com/guide/mac-help/set-up-a-focus-to-stay-on-task-mchl613dc43f/mac)). Time-sensitive delivery is opt-out per app rather than off by default, so a messaging or calendar app you never explicitly allowed can still break through the quiet. Do Not Disturb narrows the odds sharply; it does not take them to zero. For an internal clip that is plenty. For a recording that ships, plan for the carve-outs instead of trusting the toggle.

## The second notification surface hiding in your browser

Silence the OS and a browser recording still has its own emitter: every site you ever granted notification permission. A web notification travels through "the operating system's native notification system," the same layer Do Not Disturb governs, but it originates from a site rather than an app, and an "Allow" you clicked months ago for webmail, a chat app, or a calendar is still armed ([MDN, 2026](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)). Because those route through the OS, OS Do Not Disturb does suppress them — yet the durable fix is a browser profile where the permission was never granted, so nothing is even queued to fire. This is one more reason [scoping the capture to a single browser tab](/blog/record-a-browser-tab) earns its keep: the OS toast layer is drawn above the tab and cannot render inside it, and a clean profile has no armed permissions sitting behind it.

## Record where nothing can fire: the isolation ladder

For a recording that genuinely cannot leak, climb from "ask the OS to hold notifications" to "record somewhere no notification exists." Four rungs, each removing an emitter instead of silencing one:

1. **Do Not Disturb.** The OS holds most toasts, subject to the carve-outs above. Free, instant, imperfect.
2. **A clean recording profile.** A fresh browser profile or user account with nothing logged in, no extensions, and notification permission denied. Nothing is armed, so nothing fires. This is the [capture-hygiene step a produced recording performs anyway](/blog/professional-screen-recordings).
3. **A scoped surface.** Record one browser tab or one window, so the OS notification layer draws outside the frame entirely.
4. **A headless environment.** A browser rendered with no desktop session has no notification daemon running at all, so a toast is not suppressed, it is impossible. This is [the display-less setup used to render demos on a CI runner](/blog/headless-screen-recording).

Our own engine, aidemo, sits on that top rung: an agent-authored storyboard steers a real Chrome tab, headless on a runner, so no notification daemon is even alive to interrupt the take. The honest limits are familiar ones. aidemo captures a browser tab only, never a native desktop app; the demo is specified in a storyboard you edit as code, not on a drag-and-drop timeline; and for a one-off clip, switching on Do Not Disturb beats wiring up a whole pipeline.

## Match the isolation to the stakes

You do not need a headless runner to record a note for a teammate, and Do Not Disturb is not enough for an asset that ships forever. Pick the rung by what a leak would cost.

| The recording | Cost of a leaked toast | The rung that fits |
|---|---|---|
| An internal clip for one teammate | A moment of mild embarrassment | Do Not Disturb |
| A conference talk or live webinar | A whole audience reads your DMs | Do Not Disturb plus a clean profile |
| A landing-page or launch video | A real customer name ships forever | Clean profile plus a scoped tab |
| An app-store preview or CI-rendered demo | A leak in an asset that re-renders unattended | Headless, with no notification layer at all |

The pattern down that column is that the stakes track how far the recording travels and how hard a reshoot would be. A live take you can redo the next morning; an asset that regenerates on every commit has to be leak-proof by construction, because nobody is watching the render. That is why the top rung stops being paranoia and becomes the default: the further a recording gets from the person who made it, the less it can depend on someone remembering to flip a switch.

## Sources

- [Apple Support — Turn a Focus on or off on Mac](https://support.apple.com/guide/mac-help/turn-a-focus-on-or-off-mchl999b7c1a/mac)
- [Apple Support — Set up a Focus to stay on task on Mac](https://support.apple.com/guide/mac-help/set-up-a-focus-to-stay-on-task-mchl613dc43f/mac)
- [Microsoft Support — Change notification settings in Windows](https://support.microsoft.com/en-us/windows/change-notification-settings-in-windows-8942c744-6198-fe56-4639-34320cf9444e)
- [GNOME Help — Hide notifications](https://help.gnome.org/users/gnome-help/stable/shell-notifications.html.en)
- [MDN — Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)

## FAQ

### How do I turn off notifications before recording on Mac, Windows, and Linux?

On a Mac, hold the Option key and click the date and time in the menu bar to toggle Do Not Disturb, or open Control Center and click the Focus section. On Windows 11, open the notification center and click the bell icon marked zZ. On GNOME Linux, open the notification list and switch Do Not Disturb on at the bottom. For a recording you make often, set Windows to enable Do Not Disturb automatically when you duplicate your display, so it never depends on memory.

### Does Do Not Disturb hide every notification?

No. It is a policy filter with deliberate exceptions, so some alerts still appear. macOS still shows time-sensitive notifications and any people or apps you allowed; Windows still shows priority notifications such as incoming calls and reminders, plus alarms; GNOME still shows critical alerts like a low battery. For a recording that ships publicly, back Do Not Disturb up with a clean profile so nothing is armed to break through in the first place.

### Will website push notifications still appear when Do Not Disturb is on?

Web push notifications are rendered by the operating system's native notification system, so OS Do Not Disturb suppresses them the same way it suppresses app toasts. The catch is that any site you once granted permission to stays armed, so the safer move for a demo is to record in a browser profile where notification permission was never granted, which leaves nothing queued to fire at all.
