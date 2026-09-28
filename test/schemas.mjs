// JSON schemas for the Edays API V2 records this server reads and writes. Edays publishes no OpenAPI
// document for API V2, only JSON examples on https://developer.e-days.co.uk, so these schemas were
// written from those examples: every documented key is required, no other key is allowed, and the
// type of each key is the type shown in the example (null is allowed only where an example shows
// null). e2e.mjs checks each schema against the documented example it was written from (spec.json,
// extracted by extract-examples.mjs) before using it on the fixtures and the mock.
const GUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
// Absence times are documented as "2017-04-13 09:00"; the user dates as "1973-10-24T00:00:00".
const ABSENCE_TIME = "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$";
const DOTNET_DATE = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$";

const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const nullable = (s) => ({ ...s, type: [s.type, "null"] });
const object = (properties, { optional = [] } = {}) => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
});
export const arrayOf = (items, minItems = 0) => ({ type: "array", items, minItems });

// Authentication: "Example POST Response" of /token is a one-element array around the token object.
export const TokenRecord = object({ token_type: str, access_token: { type: "string", minLength: 1 }, expires_in: int, ".issued": str, ".expires": str });
export const TokenResponse = arrayOf(TokenRecord, 1);

// Users: GET /api/v2/users (with EdaysId) and GET /api/v2/users/{partnerUserId} (without, in the example).
const userProperties = {
  PartnerId: str,
  FirstName: str,
  LastName: str,
  Email: str,
  Login: str,
  SsoUserId: str,
  PayrollNumber: str,
  EmployeeNumber: str,
  SettingsTemplateId: str,
  PartnerSettingsTemplateId: str,
  IsLeaver: bool,
  Dob: { type: "string", pattern: DOTNET_DATE },
  HomeAddress: str,
  HomePhone: str,
  HomeEmail: str,
  WorkPhone: str,
  WorkPhoneExt: str,
  NextOfKin: str,
  NextOfKinContactDetails: str,
  JobTitle: str,
  AnnualPay: num,
  EmploymentStartDate: nullable({ type: "string", pattern: DOTNET_DATE }),
  ContinuousStartDate: nullable({ type: "string", pattern: DOTNET_DATE }),
  ClientProvidedId: str,
  FTE: num,
  CalendarYearStartMonth: int,
  CalendarYearStartDay: int,
  HoursPerDay: num,
};
export const UserListItem = object({ EdaysId: { type: "string", pattern: GUID }, ...userProperties });
export const UserSingle = object(userProperties);

// GET /api/v2/users/{partnerUserId}/groups
export const UserGroup = object({ GroupEdaysId: { type: "string", pattern: GUID }, GroupPartnerId: str, GroupName: str });

// GET /api/v2/users/{partnerUserId}/authorisation
export const Authorisation = object({
  UserPartnerId: str,
  StepOneAuthoriserPartnerId: str,
  StepOneAltAuthoriserPartnerIds: arrayOf(str),
  StepTwoAuthoriserPartnerId: str,
  StepTwoAltAuthoriserPartnerIds: arrayOf(str),
});

// Absences: GET /api/v2/absences and GET /api/v2/absences/{AbsenceId} share one shape; the
// GET /api/v2/users/{partnerUserId}/absences example lacks four of its keys.
const absenceCore = {
  Id: { type: "string", pattern: GUID },
  UserId: { type: "string", pattern: GUID },
  FirstName: str,
  LastName: str,
  AbsenceTypeId: int,
  Status: str,
  StartTime: { type: "string", pattern: ABSENCE_TIME },
  EndTime: { type: "string", pattern: ABSENCE_TIME },
  DurationInDays: num,
  DurationInMinutes: int,
  DateCreated: { type: "string", pattern: ABSENCE_TIME },
  IsOpen: bool,
};
export const Absence = object({ ...absenceCore, PayrollNumber: str, EmployeeNumber: str, DateModified: { type: "string", pattern: ABSENCE_TIME }, BookedInTimeUnit: str });
export const UserAbsence = object(absenceCore);
// POST /api/v2/absences and PUT /api/v2/absences/{AbsenceId} request body.
export const AbsenceRequest = object({
  UserId: { type: "string", pattern: GUID },
  AbsenceTypeId: int,
  Details: str,
  Status: str,
  StartTime: { type: "string", pattern: ABSENCE_TIME },
  EndTime: { type: "string", pattern: ABSENCE_TIME },
  IsOpen: bool,
});

// GET /api/v2/absencetypes and GET /api/v2/absencetypes/{absenceTypeId}
export const AbsenceType = object({
  Id: int,
  Name: str,
  RecordTypeDiscriminator: int,
  CanBookOwn: bool,
  CanBookReportees: bool,
  CanBookOthers: bool,
  CanViewInCalendarOwn: bool,
  CanViewInCalendarReportees: bool,
  CanViewInCalendarOthers: bool,
});

// GET /api/v2/users/{partnerUserId}/entitlements/deducting (and .../entitlements/{entitlementId})
export const DeductingEntitlement = object({
  UserId: { type: "string", pattern: GUID },
  Login: str,
  ElementId: int,
  ElementName: str,
  BookingPeriod: int,
  AnnualEntitlement: num,
  Transfers: num,
  PendingApproval: num,
  TotalBooked: num,
  Taken: num,
  Untaken: num,
  Remaining: num,
  TimeUnit: int,
  EntitlementPotId: int,
  EntitlementIsEnabled: bool,
});
// GET /api/v2/users/{partnerUserId}/entitlements/summing
export const SummingEntitlement = object({ EntitlementPotId: int, EntitlementName: str, YearToDate: num, Last6Months: num, Last3Months: num, Last30Days: num });
// GET /api/v2/users/{partnerUserId}/entitlements/pots
export const EntitlementPot = object({ PotId: int, Description: str, RecordType: int, EntitlementIsEnabled: bool });

// GET /api/v2/users/{partnerUserId}/rotas, .../publicholidays, .../customdays
export const RotaAssignment = object({ Rota: int, StartDate: { type: "string", pattern: DOTNET_DATE } });
export const Pattern = object({ Pattern: int });

// GET /api/v2/grouptypes and GET /api/v2/grouptypes/{groupTypePartnerId}/groups
export const GroupType = object({ Id: int, GroupTypePartnerId: str, Name: str, Priority: int, RequiredField: bool, AllowMultipleSelections: bool });
export const Group = object({ Id: { type: "string", pattern: GUID }, GroupPartnerId: str, Name: str, Priority: int, MinimumStaffingLevel: int });

// Lists: {Value, Text} (rotas, publicholidays, customdays, recordstatus, ...) or {Key, Value} (timeunits, bookingperiods).
export const ValueTextItem = object({ Value: { type: ["integer", "string"] }, Text: str });
export const KeyValueItem = object({ Key: int, Value: str });

/** Which schema each documented example must satisfy: [path, method, kind, schema]. */
export const DOCUMENTED_EXAMPLES = [
  ["/token", "POST", "response", TokenResponse],
  ["/api/v2/users", "GET", "response", arrayOf(UserListItem, 1)],
  ["/api/v2/users/{partnerUserId}", "GET", "response", UserSingle],
  ["/api/v2/users/{partnerUserId}/groups", "GET", "response", arrayOf(UserGroup, 1)],
  ["/api/v2/users/{partnerUserId}/authorisation", "GET", "response", arrayOf(Authorisation, 1)],
  ["/api/v2/users/{partnerUserId}/absences", "GET", "response", arrayOf(UserAbsence, 1)],
  ["/api/v2/users/{partnerUserId}/entitlements/deducting", "GET", "response", arrayOf(DeductingEntitlement, 1)],
  ["/api/v2/users/{partnerUserId}/entitlements/summing", "GET", "response", arrayOf(SummingEntitlement, 1)],
  ["/api/v2/users/{partnerUserId}/entitlements/pots", "GET", "response", arrayOf(EntitlementPot, 1)],
  ["/api/v2/users/{partnerUserId}/rotas", "GET", "response", arrayOf(RotaAssignment, 1)],
  ["/api/v2/users/{partnerUserId}/publicholidays", "GET", "response", arrayOf(Pattern, 1)],
  ["/api/v2/absences", "GET", "response", arrayOf(Absence, 1)],
  ["/api/v2/absences", "POST", "request", AbsenceRequest],
  ["/api/v2/absences/{AbsenceId}", "GET", "response", Absence],
  ["/api/v2/absences/{AbsenceId}", "PUT", "request", AbsenceRequest],
  ["/api/v2/absencetypes", "GET", "response", arrayOf(AbsenceType, 1)],
  ["/api/v2/absencetypes/{absenceTypeId}", "GET", "response", AbsenceType],
  ["/api/v2/grouptypes", "GET", "response", arrayOf(GroupType, 1)],
  ["/api/v2/grouptypes/{groupTypePartnerId}/groups", "GET", "response", arrayOf(Group, 1)],
  ["/api/v2/lists/rotas", "GET", "response", arrayOf(ValueTextItem, 1)],
  ["/api/v2/lists/publicholidays", "GET", "response", arrayOf(ValueTextItem, 1)],
  ["/api/v2/lists/customdays", "GET", "response", arrayOf(ValueTextItem, 1)],
  ["/api/v2/lists/recordstatus", "GET", "response", arrayOf(ValueTextItem, 1)],
  ["/api/v2/lists/recordtypediscriminators", "GET", "response", arrayOf(ValueTextItem, 1)],
  ["/api/v2/lists/timeunits", "GET", "response", arrayOf(KeyValueItem, 1)],
  ["/api/v2/lists/bookingperiods", "GET", "response", arrayOf(KeyValueItem, 1)],
];
