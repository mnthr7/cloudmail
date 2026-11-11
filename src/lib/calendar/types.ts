/** Shapes the calendar API returns, shared by the server and the views. */

export const CALENDAR_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'teal', 'gray'] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

/** The same colors the calendar grid uses, for dots and swatches elsewhere. */
export const CALENDAR_HEX: Record<CalendarColor, string> = {
	blue: '#3b6fd8',
	green: '#2f9e5b',
	purple: '#8250df',
	orange: '#d9822b',
	red: '#d1453b',
	teal: '#1f9aa5',
	gray: '#7a7f87'
};

export type CalendarInfo = {
	id: string;
	name: string;
	color: CalendarColor;
	/** Default zone for new events on it. */
	timezone: string;
	isDefault: boolean;
	/** A secret subscribe link is on. */
	hasFeed: boolean;
	/** A read-only copy of an outside calendar (Google, iCloud, Outlook). Null: your own. */
	source: CalendarSource | null;
};

export type CalendarSource = {
	/** Where it comes from, for display ("calendar.google.com"). */
	host: string;
	/** Titles and places are copied; otherwise just "Busy". */
	details: boolean;
	syncedAt: string | null;
	/** Why the last refresh failed, in plain words. */
	error: string | null;
};

/** One occurrence of an event in the range being shown. */
export type Occurrence = {
	/** The row to edit: the event, or an edited copy of one occurrence. */
	eventId: string;
	/** The series it belongs to (the event itself when it doesn't repeat). */
	seriesId: string;
	/** For a repeating event, which occurrence this is ("2026-11-10T09:00"). */
	occurrence: string | null;
	recurring: boolean;
	calendarId: string;
	color: CalendarColor;
	title: string;
	description: string | null;
	location: string | null;
	allDay: boolean;
	/** UTC start and end. All-day ends are exclusive midnights. */
	start: string;
	end: string;
	/** Wall clock in the event's own zone. */
	startLocal: string;
	endLocal: string;
	timezone: string;
	rrule: string | null;
	/** Where the series starts (its first occurrence), for "all events" edits. */
	seriesStartLocal: string;
	transparency: 'busy' | 'free';
	/** Someone else organizes it (an invite you accepted). Null: it's yours. */
	organizer: { email: string; name: string | null } | null;
	/** Your answer to that invite. */
	myStatus: string | null;
	/** The email the invite came in. */
	sourceEmailId: string | null;
};

export type AttendeeView = { email: string; name: string | null; partstat: string };

/** An invite, update, cancellation or RSVP that arrived by email, as the reader shows it. */
export type InviteView = {
	id: string;
	method: string;
	title: string;
	when: string;
	location: string | null;
	organizer: { email: string; name: string | null } | null;
	/** Your answer, if you gave one. */
	response: string | null;
	/** It's on your calendar now. */
	onCalendar: boolean;
	/** For an RSVP to your event: who answered and what. */
	reply: { email: string; name: string | null; partstat: string } | null;
	/** For a guest proposing a new time (COUNTER): your event's time as it stands now. */
	proposal: { current: string | null } | null;
};
