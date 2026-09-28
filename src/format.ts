// Turn Edays API V2 records into compact objects an assistant can read quickly.
// Field names follow the JSON examples on https://developer.e-days.co.uk (users, absences, absence
// types, entitlements, rotas, public holidays, custom days, group types, groups, authorisation, lists).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so GUIDs, numeric IDs, timestamps and
// hyphenated references such as PO-0001-000123 are left alone. Any other 9-11 digit string starting
// with 0 (an order number, say) is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;
// UK postcodes (CF64 3DH, SW1A 1AA, M1 1AE, EC1A1BB): one or two capitals, a digit, an optional
// letter or digit, an optional space, a digit and two capitals, not touching other letters or digits.
// Upper case only, so ordinary words are left alone; a code such as a licence plate written in the
// same shape would be redacted too.
const POSTCODE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Za-z0-9])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]").replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences and UK postcodes inside free text (names, job
 * titles, group and entitlement names, error messages) unless contact details were requested. Dates
 * inside free text are not touched: a date in a rota or group name is far more likely to be a
 * schedule than a date of birth, and the Dob field itself is withheld by user().
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

// Documented list values (Lists section). They are read from the examples on the documentation page;
// the /api/v2/lists/... endpoints return the same Key/Value or Value/Text pairs for a given system.
export const RECORD_TYPE_DISCRIMINATORS: Record<string, string> = { "1": "Planned", "2": "Unplanned", "5": "Custom Day Group", "6": "Public Holiday Group" };
export const TIME_UNITS: Record<string, string> = { "0": "Days", "1": "Minutes", "2": "Hours", "-1": "Inherited" };
export const BOOKING_PERIODS: Record<string, string> = { "0": "Any", "1": "LastTwelveMonths", "2": "Current", "3": "MinusOne", "4": "MinusTwo", "5": "MinusThree", "6": "PlusOne", "7": "PlusTwo", "8": "PlusThree", "9": "OutOfRange" };
export const RECORD_STATUSES = ["Pending", "Approved", "Rejected", "CancellationPending", "Cancelled", "Taken", "CancellationRejected"] as const;

const named = (table: Record<string, string>, v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : table[String(n)] ?? `unknown (${n})`;
};

// User record (GET /api/v2/users returns EdaysId as well; GET /api/v2/users/{partnerUserId} does not
// in the documented example). PartnerId is the key every user endpoint is addressed by, so it is always
// returned. Email, Login, home/work phones and emails, address, next of kin, date of birth, payroll and
// employee numbers, SSO and client-provided IDs and annual pay are personal or HR data: only on request.
export function user(u: Rec, includeContact: boolean) {
  return {
    partner_id: str(u.PartnerId),
    edays_id: str(u.EdaysId),
    name: redactContacts([u.FirstName, u.LastName].filter((x) => typeof x === "string" && x).join(" "), includeContact),
    job_title: redactContacts(u.JobTitle, includeContact),
    is_leaver: bool(u.IsLeaver),
    settings_template_id: str(u.SettingsTemplateId),
    settings_template_partner_id: str(u.PartnerSettingsTemplateId),
    employment_start_date: str(u.EmploymentStartDate),
    continuous_start_date: str(u.ContinuousStartDate),
    fte: num(u.FTE),
    hours_per_day: num(u.HoursPerDay),
    calendar_year_start: u.CalendarYearStartMonth !== undefined || u.CalendarYearStartDay !== undefined ? { month: num(u.CalendarYearStartMonth), day: num(u.CalendarYearStartDay) } : undefined,
    ...(includeContact
      ? {
          email: str(u.Email),
          login: str(u.Login),
          home_email: str(u.HomeEmail),
          home_phone: str(u.HomePhone),
          work_phone: str(u.WorkPhone),
          work_phone_ext: str(u.WorkPhoneExt),
          home_address: str(u.HomeAddress),
          next_of_kin: str(u.NextOfKin),
          next_of_kin_contact_details: str(u.NextOfKinContactDetails),
          date_of_birth: str(u.Dob),
          payroll_number: str(u.PayrollNumber),
          employee_number: str(u.EmployeeNumber),
          sso_user_id: str(u.SsoUserId),
          client_provided_id: str(u.ClientProvidedId),
          annual_pay: num(u.AnnualPay),
        }
      : {}),
  };
}

// GET /api/v2/users/{partnerUserId}/groups
export function userGroup(g: Rec, includeContact: boolean) {
  return { group_edays_id: str(g.GroupEdaysId), group_partner_id: str(g.GroupPartnerId), name: redactContacts(g.GroupName, includeContact) };
}

// GET /api/v2/users/{partnerUserId}/authorisation. The values are partner IDs of other users: keys
// that get_user takes, so they are returned as stored like every other partner ID, even on a system
// whose partner IDs are login email addresses (a redacted key could not be looked up).
export function authorisation(a: Rec) {
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== undefined) : undefined);
  return {
    user_partner_id: str(a.UserPartnerId),
    step_one_authoriser: str(a.StepOneAuthoriserPartnerId),
    step_one_alternates: ids(a.StepOneAltAuthoriserPartnerIds),
    step_two_authoriser: str(a.StepTwoAuthoriserPartnerId),
    step_two_alternates: ids(a.StepTwoAltAuthoriserPartnerIds),
  };
}

// GET /api/v2/absences, GET /api/v2/absences/{AbsenceId} and GET /api/v2/users/{partnerUserId}/absences
// (the per-user example has no PayrollNumber, EmployeeNumber, DateModified or BookedInTimeUnit).
export function absence(a: Rec, includeContact: boolean) {
  return {
    id: str(a.Id),
    user_id: str(a.UserId),
    name: redactContacts([a.FirstName, a.LastName].filter((x) => typeof x === "string" && x).join(" "), includeContact),
    absence_type_id: num(a.AbsenceTypeId),
    status: str(a.Status),
    start: str(a.StartTime),
    end: str(a.EndTime),
    duration_days: num(a.DurationInDays),
    duration_minutes: num(a.DurationInMinutes),
    is_open: bool(a.IsOpen),
    booked_in_time_unit: str(a.BookedInTimeUnit),
    date_created: str(a.DateCreated),
    date_modified: str(a.DateModified),
    ...(includeContact ? { payroll_number: str(a.PayrollNumber), employee_number: str(a.EmployeeNumber) } : {}),
  };
}

// GET /api/v2/absencetypes. A GET "will also return Custom Day Groups and Public Holiday Groups, and
// these are differentiated by the record type discriminator of 5 and 6 respectively".
export function absenceType(t: Rec, includeContact: boolean) {
  return {
    id: num(t.Id),
    name: redactContacts(t.Name, includeContact),
    record_type_discriminator: num(t.RecordTypeDiscriminator),
    record_type: named(RECORD_TYPE_DISCRIMINATORS, t.RecordTypeDiscriminator),
    can_book_own: bool(t.CanBookOwn),
    can_book_reportees: bool(t.CanBookReportees),
    can_book_others: bool(t.CanBookOthers),
    can_view_in_calendar_own: bool(t.CanViewInCalendarOwn),
    can_view_in_calendar_reportees: bool(t.CanViewInCalendarReportees),
    can_view_in_calendar_others: bool(t.CanViewInCalendarOthers),
  };
}

// GET /api/v2/users/{partnerUserId}/entitlements/deducting (and .../entitlements/{entitlementId}).
// Login is the user's sign-in name (an email address on many systems): only on request.
export function deductingEntitlement(e: Rec, includeContact: boolean) {
  return {
    entitlement_pot_id: num(e.EntitlementPotId),
    element_id: num(e.ElementId),
    element_name: redactContacts(e.ElementName, includeContact),
    booking_period: num(e.BookingPeriod),
    booking_period_name: named(BOOKING_PERIODS, e.BookingPeriod),
    annual_entitlement: num(e.AnnualEntitlement),
    transfers: num(e.Transfers),
    pending_approval: num(e.PendingApproval),
    total_booked: num(e.TotalBooked),
    taken: num(e.Taken),
    untaken: num(e.Untaken),
    remaining: num(e.Remaining),
    time_unit: num(e.TimeUnit),
    time_unit_name: named(TIME_UNITS, e.TimeUnit),
    enabled: bool(e.EntitlementIsEnabled),
    user_id: str(e.UserId),
    ...(includeContact ? { login: str(e.Login) } : {}),
  };
}

// GET /api/v2/users/{partnerUserId}/entitlements/summing
export function summingEntitlement(e: Rec, includeContact: boolean) {
  return {
    entitlement_pot_id: num(e.EntitlementPotId),
    entitlement_name: redactContacts(e.EntitlementName, includeContact),
    year_to_date: num(e.YearToDate),
    last_6_months: num(e.Last6Months),
    last_3_months: num(e.Last3Months),
    last_30_days: num(e.Last30Days),
  };
}

// GET /api/v2/users/{partnerUserId}/entitlements/pots
export function entitlementPot(p: Rec, includeContact: boolean) {
  return { pot_id: num(p.PotId), description: redactContacts(p.Description, includeContact), record_type: num(p.RecordType), enabled: bool(p.EntitlementIsEnabled) };
}

// GET /api/v2/lists/... items come as {Value, Text} or {Key, Value}.
export function listItem(item: Rec, includeContact: boolean): { value: string | number | undefined; text: string | undefined } {
  if ("Key" in item) return { value: item.Key, text: redactContacts(item.Value, includeContact) };
  return { value: item.Value, text: redactContacts(item.Text, includeContact) };
}

/** Name lookup for a documented list (Value -> Text). */
export function listLookup(items: unknown, includeContact: boolean): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (Array.isArray(items)) for (const it of items) if (it && typeof it === "object") {
    const { value, text } = listItem(it as Rec, includeContact);
    if (value !== undefined && value !== null) out.set(String(value), text);
  }
  return out;
}

// GET /api/v2/users/{partnerUserId}/rotas: {Rota, StartDate}; names from /api/v2/lists/rotas.
export function rotaAssignment(r: Rec, names: Map<string, string | undefined>) {
  const id = num(r.Rota);
  return { rota: id, rota_name: id === undefined ? undefined : names.get(String(id)), start_date: str(r.StartDate) };
}

// GET /api/v2/users/{partnerUserId}/publicholidays and .../customdays: {Pattern}.
export function pattern(p: Rec, names: Map<string, string | undefined>) {
  const id = num(p.Pattern);
  return { pattern: id, name: id === undefined ? undefined : names.get(String(id)) };
}

// GET /api/v2/grouptypes
export function groupType(t: Rec, includeContact: boolean) {
  return {
    id: num(t.Id),
    partner_id: str(t.GroupTypePartnerId),
    name: redactContacts(t.Name, includeContact),
    priority: num(t.Priority),
    required_field: bool(t.RequiredField),
    allow_multiple_selections: bool(t.AllowMultipleSelections),
  };
}

// GET /api/v2/grouptypes/{groupTypePartnerId}/groups
export function group(g: Rec, includeContact: boolean) {
  return { id: str(g.Id), partner_id: str(g.GroupPartnerId), name: redactContacts(g.Name, includeContact), priority: num(g.Priority), minimum_staffing_level: num(g.MinimumStaffingLevel) };
}
