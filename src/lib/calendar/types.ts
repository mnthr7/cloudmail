/** Shapes the calendar API returns, shared by the server and the views. */

export const CALENDAR_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'teal', 'gray'] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export type CalendarInfo = {
	id: string;
	name: string;
	color: CalendarColor;
	/** Default zone for new events on it. */
	timezone: string;
	isDefault: boolean;
	/** A secret subscribe link is on. */
	hasFeed: boolean;
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
};
