// Fake Edays data shaped exactly like the JSON examples on developer.e-days.co.uk (validated in
// e2e.mjs against the schemas in schemas.mjs, which are in turn checked against those examples).
// Dates: user dates use the ".NET" form 2017-10-19T00:00:00, absence times "2017-04-13 09:00".
const dotnet = (d) => `${d}T00:00:00`;
const at = (d, h = 9, m = 0) => `${d} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
// Deterministic GUIDs: seed -> 8-4-4-4-12 lowercase hex (mulberry32, exact 32-bit arithmetic so
// different seeds never collide through floating-point rounding).
export const guid = (seed) => {
  let x = (seed * 0x9e3779b1) >>> 0;
  let out = "";
  while (out.length < 32) {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out += ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, "0");
  }
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`;
};

// ---- Users (GET /api/v2/users) ----
export const DANA = "d.barrett";
export const WILLIE = "w.barrett";
export const PRIYA = "p.shah";
export const LEE = "l.chen";
export const LEAVER = "r.bank";
export const U_DANA = guid(1);
export const U_WILLIE = guid(2);
export const U_PRIYA = guid(3);
export const U_LEE = guid(4);
export const U_LEAVER = guid(5);
const TEMPLATE = "521c3811-38cc-e111-833b-00155d000918";
const mkUser = (edaysId, partnerId, first, last, email, { leaver = false, dob = "1973-10-24", job = "", pay = 32000, start = "2019-04-01", payroll, employee, homePhone = "", workPhone = "", address = "", nok = "", nokDetails = "", clientId = "", fte = 1.0 } = {}) => ({
  EdaysId: edaysId,
  PartnerId: partnerId,
  FirstName: first,
  LastName: last,
  Email: email,
  Login: email,
  SsoUserId: "",
  PayrollNumber: payroll ?? `P${partnerId.replace(/\W/g, "").slice(0, 6)}`,
  EmployeeNumber: employee ?? `E${partnerId.replace(/\W/g, "").slice(0, 6)}`,
  SettingsTemplateId: TEMPLATE,
  PartnerSettingsTemplateId: "default-template",
  IsLeaver: leaver,
  Dob: dotnet(dob),
  HomeAddress: address,
  HomePhone: homePhone,
  HomeEmail: "",
  WorkPhone: workPhone,
  WorkPhoneExt: "",
  NextOfKin: nok,
  NextOfKinContactDetails: nokDetails,
  JobTitle: job,
  AnnualPay: pay,
  EmploymentStartDate: start ? dotnet(start) : null,
  ContinuousStartDate: start ? dotnet(start) : null,
  ClientProvidedId: clientId,
  FTE: fte,
  CalendarYearStartMonth: 1,
  CalendarYearStartDay: 1,
  HoursPerDay: 7.5,
});
const named = [
  mkUser(U_DANA, DANA, "Dana", "Barrett", "d.barrett@example.com", { job: "Programmer", homePhone: "07700 900123", workPhone: "0117 496 0000", address: "1 Plymouth Road, Penarth CF64 3DH", nok: "Sam Barrett", nokDetails: "07700 900456", clientId: "HR-000123", payroll: "P123", employee: "E123" }),
  mkUser(U_WILLIE, WILLIE, "Willie", "Barrett", "w.barrett@example.com", { dob: "1953-06-12", job: "Team lead", pay: 48000, start: "2015-09-14", fte: 0.8 }),
  // A job title with a phone number typed into it, and a surname with an email typed into it: free text
  // that must be redacted by default even though it is not a contact field.
  mkUser(U_PRIYA, PRIYA, "Priya", "Shah", "p.shah@example.com", { job: "Sales (call 07700 900111)", start: "2024-02-05" }),
  mkUser(U_LEE, LEE, "Lee", "Chen (lee.chen@example.net)", "l.chen@example.com", { job: "Designer", start: null }),
  mkUser(U_LEAVER, LEAVER, "Robbie", "Bank", "r.bank@example.com", { leaver: true, job: "Analyst", start: "2018-01-08" }),
];
// 20 more so name and partner-ID queries have something to skip.
const bulk = Array.from({ length: 20 }, (_, i) => mkUser(guid(100 + i), `user-${String(i + 1).padStart(2, "0")}`, `Person${i + 1}`, `Surname${i + 1}`, `person${i + 1}@example.org`, { dob: "1990-01-15", job: i % 2 ? "Engineer" : "Support", start: "2021-06-01" }));
export const users = [...named, ...bulk];
export const userByPartnerId = Object.fromEntries(users.map((u) => [u.PartnerId, u]));

// ---- Absence types (GET /api/v2/absencetypes). Record type discriminators: 1 planned, 2 unplanned,
// 5 custom day group, 6 public holiday group (Absence Types section). ----
const mkType = (Id, Name, disc, { own = true, reportees = true, others = false } = {}) => ({
  Id,
  Name,
  RecordTypeDiscriminator: disc,
  CanBookOwn: own,
  CanBookReportees: reportees,
  CanBookOthers: others,
  CanViewInCalendarOwn: true,
  CanViewInCalendarReportees: true,
  CanViewInCalendarOthers: false,
});
export const HOLIDAY = 1;
export const SICKNESS = 2;
export const WFH = 3;
export const absenceTypes = [
  mkType(HOLIDAY, "Holiday", 1),
  mkType(SICKNESS, "Sickness", 2, { own: false }),
  mkType(WFH, "Working from home", 1),
  mkType(5, "Christmas Shutdown", 5, { own: false, reportees: false }),
  mkType(6, "UK Public Holidays", 6, { own: false, reportees: false }),
];

// ---- Absences (GET /api/v2/absences; the per-user endpoint serves the same records without
// PayrollNumber, EmployeeNumber, DateModified and BookedInTimeUnit) ----
const mkAbsence = (seed, user, typeId, status, start, end, { days, minutes, created, modified, open = false, unit = "Days" } = {}) => ({
  Id: guid(1000 + seed),
  UserId: user.EdaysId,
  FirstName: user.FirstName,
  LastName: user.LastName,
  PayrollNumber: user.PayrollNumber,
  EmployeeNumber: user.EmployeeNumber,
  AbsenceTypeId: typeId,
  Status: status,
  StartTime: start,
  EndTime: end,
  DurationInDays: days ?? 1,
  DurationInMinutes: minutes ?? (days ?? 1) * 450,
  DateCreated: created ?? at("2026-09-01", 9, 0),
  DateModified: modified ?? created ?? at("2026-09-01", 9, 0),
  IsOpen: open,
  BookedInTimeUnit: unit,
});
const dana = userByPartnerId[DANA];
const willie = userByPartnerId[WILLIE];
const priya = userByPartnerId[PRIYA];
export const absences = [
  mkAbsence(1, dana, HOLIDAY, "Approved", at("2026-10-05", 0, 0), at("2026-10-10", 0, 0), { days: 5, created: at("2026-08-20", 10, 15), modified: at("2026-08-21", 8, 0) }),
  mkAbsence(2, dana, SICKNESS, "Taken", at("2026-09-14", 9, 0), at("2026-09-15", 17, 30), { days: 2, created: at("2026-09-14", 8, 5), modified: at("2026-09-16", 9, 0) }),
  mkAbsence(3, dana, WFH, "Approved", at("2026-10-13", 0, 0), at("2026-10-14", 0, 0), { created: at("2026-09-25", 11, 0) }),
  mkAbsence(4, willie, HOLIDAY, "Pending", at("2026-10-19", 0, 0), at("2026-10-24", 0, 0), { days: 5, created: at("2026-09-28", 9, 30) }),
  mkAbsence(5, willie, SICKNESS, "Taken", at("2026-10-01", 9, 0), at("2026-10-01", 17, 30), { created: at("2026-10-01", 8, 0), modified: at("2026-10-02", 9, 0), open: false }),
  mkAbsence(6, priya, HOLIDAY, "Rejected", at("2026-10-07", 0, 0), at("2026-10-08", 0, 0), { created: at("2026-09-10", 14, 0), modified: at("2026-09-11", 9, 0) }),
  mkAbsence(7, priya, HOLIDAY, "Approved", at("2026-10-26", 0, 0), at("2026-10-31", 0, 0), { days: 5, created: at("2026-09-02", 9, 0) }),
  mkAbsence(8, priya, SICKNESS, "Taken", at("2026-10-12", 9, 0), at("2026-10-12", 17, 30), { minutes: 450, created: at("2026-10-12", 8, 30), open: true, unit: "Hours" }),
  mkAbsence(9, dana, HOLIDAY, "Cancelled", at("2026-11-02", 0, 0), at("2026-11-04", 0, 0), { days: 2, created: at("2026-09-05", 9, 0), modified: at("2026-09-06", 9, 0) }),
  mkAbsence(10, willie, WFH, "Approved", at("2026-10-06", 0, 0), at("2026-10-07", 0, 0), { created: at("2026-09-20", 9, 0) }),
  mkAbsence(11, dana, HOLIDAY, "Pending", at("2026-12-21", 0, 0), at("2026-12-24", 0, 0), { days: 3, created: at("2026-09-27", 16, 45) }),
  mkAbsence(12, priya, WFH, "Approved", at("2026-10-20", 0, 0), at("2026-10-21", 0, 0), { created: at("2026-09-21", 9, 0) }),
  mkAbsence(13, willie, HOLIDAY, "Approved", at("2026-09-28", 0, 0), at("2026-10-02", 0, 0), { days: 4, created: at("2026-08-01", 9, 0) }),
];
export const absenceById = Object.fromEntries(absences.map((a) => [a.Id.toLowerCase(), a]));
export const A_DANA_HOLIDAY = absences[0].Id;
export const A_WILLIE_PENDING = absences[3].Id;
/** The per-user endpoint's shape: the documented example lacks these four keys. */
export const asUserAbsence = ({ PayrollNumber, EmployeeNumber, DateModified, BookedInTimeUnit, ...rest }) => rest;

// ---- Entitlements ----
const mkDeducting = (user, elementId, elementName, period, { annual = 25, transfers = 0, pending = 0, booked = 0, taken = 0, potId = 1, enabled = true } = {}) => ({
  UserId: user.EdaysId,
  Login: user.Login,
  ElementId: elementId,
  ElementName: elementName,
  BookingPeriod: period,
  AnnualEntitlement: annual,
  Transfers: transfers,
  PendingApproval: pending,
  TotalBooked: booked,
  Taken: taken,
  Untaken: booked - taken,
  Remaining: annual + transfers - booked - pending,
  TimeUnit: 0,
  EntitlementPotId: potId,
  EntitlementIsEnabled: enabled,
});
export const deducting = {
  [DANA]: [
    mkDeducting(dana, 1, "Annual Entitlement", 2, { annual: 25, transfers: 2, pending: 3, booked: 6, taken: 0 }),
    mkDeducting(dana, 1, "Annual Entitlement", 3, { annual: 25, transfers: 0, pending: 0, booked: 24, taken: 24 }),
    mkDeducting(dana, 3, "Long Service Award", 2, { annual: 2, potId: 1 }),
  ],
  [WILLIE]: [mkDeducting(willie, 1, "Annual Entitlement", 2, { annual: 20, pending: 5, booked: 9, taken: 4 })],
  [PRIYA]: [mkDeducting(priya, 1, "Annual Entitlement", 2, { annual: 25, pending: 0, booked: 7, taken: 1 })],
};
export const summing = {
  [DANA]: [{ EntitlementPotId: 2, EntitlementName: "Sickness", YearToDate: 4, Last6Months: 2, Last3Months: 2, Last30Days: 2 }],
  [WILLIE]: [{ EntitlementPotId: 2, EntitlementName: "Sickness", YearToDate: 1, Last6Months: 1, Last3Months: 1, Last30Days: 1 }],
  [PRIYA]: [{ EntitlementPotId: 2, EntitlementName: "Sickness", YearToDate: 1, Last6Months: 1, Last3Months: 1, Last30Days: 1 }],
};
export const pots = [
  { PotId: 1, Description: "Holiday", RecordType: 1, EntitlementIsEnabled: true },
  { PotId: 2, Description: "Sickness", RecordType: 2, EntitlementIsEnabled: true },
];

// ---- Rotas, public holidays, custom days (per user) and the lists that name them ----
export const rotas = { [DANA]: [{ Rota: 1, StartDate: dotnet("2019-04-01") }], [WILLIE]: [{ Rota: 1, StartDate: dotnet("2015-09-14") }, { Rota: 2, StartDate: dotnet("2026-01-05") }] };
export const publicHolidays = { [DANA]: [{ Pattern: 1 }], [WILLIE]: [{ Pattern: 2 }] };
export const customDays = { [DANA]: [{ Pattern: 1 }] };
export const lists = {
  rotas: [
    { Value: 1, Text: "Mon/Tue/Wed/Thur/Fri" },
    { Value: 2, Text: "Mon-Thu compressed (queries: rota@example.com)" },
  ],
  publicholidays: [
    { Value: 1, Text: "UK Public Holidays" },
    { Value: 2, Text: "Scotland Public Holidays" },
  ],
  customdays: [{ Value: 1, Text: "Christmas Shutdown" }],
  recordstatus: [
    { Value: 1, Text: "Pending" },
    { Value: 2, Text: "Approved" },
    { Value: 3, Text: "Rejected" },
    { Value: 4, Text: "CancellationPending" },
    { Value: 5, Text: "Cancelled" },
    { Value: 6, Text: "Taken" },
    { Value: 7, Text: "CancellationRejected" },
  ],
  recordtypediscriminators: [
    { Value: 1, Text: "Planned" },
    { Value: 2, Text: "Unplanned" },
  ],
  timeunits: [
    { Key: 0, Value: "Days" },
    { Key: 1, Value: "Minutes" },
    { Key: 2, Value: "Hours" },
    { Key: -1, Value: "Inherited" },
  ],
  bookingperiods: [
    { Key: 0, Value: "Any" },
    { Key: 1, Value: "LastTwelveMonths" },
    { Key: 2, Value: "Current" },
    { Key: 3, Value: "MinusOne" },
    { Key: 4, Value: "MinusTwo" },
    { Key: 5, Value: "MinusThree" },
    { Key: 6, Value: "PlusOne" },
    { Key: 7, Value: "PlusTwo" },
    { Key: 8, Value: "PlusThree" },
    { Key: 9, Value: "OutOfRange" },
  ],
};

// ---- Groups ----
export const groupTypes = [
  { Id: 1, GroupTypePartnerId: "cou", Name: "Country", Priority: 1, RequiredField: false, AllowMultipleSelections: false },
  { Id: 2, GroupTypePartnerId: "loc", Name: "Location", Priority: 2, RequiredField: true, AllowMultipleSelections: false },
  { Id: 3, GroupTypePartnerId: "tea", Name: "Team", Priority: 3, RequiredField: false, AllowMultipleSelections: true },
];
export const G_ENG = guid(200);
export const G_NOTT = guid(201);
export const G_PROG = guid(202);
export const groups = {
  cou: [
    { Id: G_ENG, GroupPartnerId: "eng", Name: "England", Priority: 0, MinimumStaffingLevel: 0 },
    { Id: guid(203), GroupPartnerId: "sco", Name: "Scotland", Priority: 0, MinimumStaffingLevel: 0 },
  ],
  loc: [
    { Id: G_NOTT, GroupPartnerId: "location-nottingham", Name: "Nottingham", Priority: 0, MinimumStaffingLevel: 2 },
    { Id: guid(204), GroupPartnerId: "location-cardiff", Name: "Cardiff, CF10 1AB (front desk 029 2000 0000)", Priority: 0, MinimumStaffingLevel: 1 },
  ],
  tea: [
    { Id: G_PROG, GroupPartnerId: "team-programming", Name: "Programming", Priority: 0, MinimumStaffingLevel: 1 },
    { Id: guid(205), GroupPartnerId: "team-sales", Name: "Sales", Priority: 0, MinimumStaffingLevel: 0 },
  ],
};
export const userGroups = {
  [DANA]: [
    { GroupEdaysId: G_ENG, GroupPartnerId: "eng", GroupName: "England" },
    { GroupEdaysId: G_NOTT, GroupPartnerId: "location-nottingham", GroupName: "Nottingham" },
    { GroupEdaysId: G_PROG, GroupPartnerId: "team-programming", GroupName: "Programming" },
  ],
  [WILLIE]: [{ GroupEdaysId: G_ENG, GroupPartnerId: "eng", GroupName: "England" }, { GroupEdaysId: G_PROG, GroupPartnerId: "team-programming", GroupName: "Programming" }],
  [PRIYA]: [{ GroupEdaysId: G_ENG, GroupPartnerId: "eng", GroupName: "England" }, { GroupEdaysId: guid(205), GroupPartnerId: "team-sales", GroupName: "Sales" }],
};
/** Users in a group, by the group's GUID and by its partner ID (the documentation does not say which one groupId takes). */
export const membersOfGroup = (groupId) => {
  const key = String(groupId).toLowerCase();
  return Object.entries(userGroups).filter(([, gs]) => gs.some((g) => g.GroupEdaysId.toLowerCase() === key || g.GroupPartnerId.toLowerCase() === key)).map(([pid]) => userByPartnerId[pid].EdaysId.toLowerCase());
};

// ---- Authorisation ----
export const authorisation = {
  [DANA]: [{ UserPartnerId: DANA, StepOneAuthoriserPartnerId: WILLIE, StepOneAltAuthoriserPartnerIds: [PRIYA, "j.bloggs (j.bloggs@example.com)"], StepTwoAuthoriserPartnerId: "j.joyce", StepTwoAltAuthoriserPartnerIds: ["Phil Jones"] }],
  [WILLIE]: [{ UserPartnerId: WILLIE, StepOneAuthoriserPartnerId: "j.joyce", StepOneAltAuthoriserPartnerIds: [], StepTwoAuthoriserPartnerId: "", StepTwoAltAuthoriserPartnerIds: [] }],
};
