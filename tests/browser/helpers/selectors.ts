// W076 — the browser-journey suite's central selector vocabulary.
//
// The chat surface's DOM contract is stable and class-scoped (W071's
// fidelity classes): these constants are the single place the suite knows
// element names from, so a class rename shows up as ONE diff here instead
// of scattered strings. The contract being asserted is the frozen plan §2
// WhatsApp-like model rendered with ShareNet's visual language.

/** The messenger window (one app, two internal panes). */
export const CHAT_APP = '.aurum-chat-app';
/** The conversation-list pane (first-class primary pane). */
export const CHAT_LISTPANE = '.aurum-chat-listpane';
/** The Aurum contact identity header (avatar/name/presence). */
export const CHAT_LISTHEAD = '.aurum-chat-listhead';
/** The new-conversation affordance. */
export const CHAT_NEWCHAT = '.aurum-chat-newchat';
/** The conversation search/filter affordance. */
export const CHAT_SEARCH_INPUT = '#aurum-chat-search';
/** One conversation row in the list. */
export const CHAT_CONVO = '.aurum-chat-convo';
/** The unread/new-activity badge of a conversation row. */
export const CHAT_UNREAD = '.aurum-chat-unread';
/** The thread pane (header + timeline + composer). */
export const CHAT_THREAD = '.aurum-chat-thread';
/** The thread header's back navigation (mobile's list ⇄ thread). */
export const CHAT_BACK = '.aurum-chat-back';
/** The thread header status line (switches to "working…"). */
export const CHAT_THREAD_STATUS = '.aurum-chat-thread-status';
/** The message timeline (role=log). */
export const CHAT_TIMELINE = '.aurum-chat-timeline';
/** One message row (data-side: member|aurum). */
export const CHAT_MSG = '.aurum-chat-msg';
/** The bubble of a message. */
export const CHAT_BUBBLE = '.aurum-chat-bubble';
/** The compact timestamp + delivery meta inside a bubble. */
export const CHAT_BUBBLE_META = '.aurum-chat-bubble-meta';
/** A day separator in the timeline. */
export const CHAT_DAY = '.aurum-chat-day';
/** The composer form. */
export const CHAT_COMPOSER = '.aurum-chat-composer';
/** The composer's textarea. */
export const CHAT_INPUT = '#aurum-chat-input';
/** The send affordance. */
export const CHAT_SEND = '.aurum-chat-send';
/** The working/typing indicator row. */
export const CHAT_WORKING = '.aurum-chat-working-row';
/** A contextual card embedded in the message stream (W072 contract). */
export const CHAT_CARD = '.aurum-chat-card';
/** A pending decision card's Approve action. */
export const CHAT_DECIDE_APPROVE = '.aurum-chat-decide[data-decision="approve"]';
/** A pending decision card's Reject action. */
export const CHAT_DECIDE_REJECT = '.aurum-chat-decide[data-decision="reject"]';
/** The message-level explainability affordance (W072). */
export const CHAT_EXPLAIN = '.aurum-chat-explain';
/** The evidence citations block of an answer. */
export const CHAT_CITATIONS = '.aurum-chat-citations';

/** The ShareNet-dominant product shell root. */
export const SHELL = '.aurum-shell';
/** The desktop rail (management chrome — visually secondary). */
export const RAIL = '.aurum-rail';
/** The mobile top bar. */
export const TOPBAR = '.aurum-topbar';
/** The mobile five-area bottom navigation. */
export const BOTTOMNAV = '.aurum-bottomnav';
/** The main landmark of the product shell. */
export const MAIN = 'main.aurum-main';
/** The shell's skip link (first focusable element). */
export const SKIP_LINK = '.aurum-skip';

/** The sign-in page's quick-access panel (the persona directory). */
export const AUTH_QUICK = '.aurum-auth-quick';
/** One persona row of the quick-access panel. */
export const AUTH_QUICK_PERSONA = '.aurum-auth-quick-persona';

/** The More hub (W075 capability hub). */
export const HUB_CARD = '.aurum-hub-card';
