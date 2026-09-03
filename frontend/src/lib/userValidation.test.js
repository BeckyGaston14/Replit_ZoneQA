import { activeAssignableUsers, filterUsersByStatus, validateNewUser, validatePasswordChange, validateResetPassword, validateUserEdit } from "./userValidation";

test("normalizes a valid new user", () => {
  expect(validateNewUser({
    name: "  Jane Tester ",
    email: " Jane@Example.COM ",
    role: "tester",
    active: true,
    send_welcome_email: true,
  }).payload).toEqual({
    name: "Jane Tester",
    email: "jane@example.com",
    role: "tester",
    active: true,
    send_welcome_email: true,
  });
});

test.each([
  [{ name: "", email: "jane@example.com", role: "tester" }, "Name is required"],
  [{ name: "Jane", email: "bad", role: "tester" }, "Enter a valid email address"],
  [{ name: "Jane", email: "jane@example.com", role: "owner" }, "Choose a permitted role"],
])("rejects invalid input", (input, error) => {
  expect(validateNewUser(input).error).toBe(error);
});

test("rejects duplicate email casing in the browser", () => {
  const result = validateNewUser(
    { name: "Jane", email: "JANE@EXAMPLE.COM", role: "tester", active: true },
    [{ email: "jane@example.com" }],
  );
  expect(result.error).toBe("Another user already uses this email");
});

test("only active non-deleted users are assignable", () => {
  expect(activeAssignableUsers([
    { id: "active", active: true },
    { id: "inactive", active: false },
    { id: "deleted", active: true, deleted_at: "2026-01-01" },
  ]).map((user) => user.id)).toEqual(["active"]);
});

test("filters the administration user list by active state", () => {
  const users = [{ id: "active", active: true }, { id: "legacy-active" }, { id: "inactive", active: false }];
  expect(filterUsersByStatus(users, "active").map((user) => user.id)).toEqual(["active", "legacy-active"]);
  expect(filterUsersByStatus(users, "inactive").map((user) => user.id)).toEqual(["inactive"]);
  expect(filterUsersByStatus(users, "all")).toEqual(users);
});

test("allows an edit without a password and normalizes profile fields", () => {
  expect(validateUserEdit({
    name: "  Jane Tester ",
    email: " JANE@EXAMPLE.COM ",
    role: "tester",
    new_password: "",
    new_password_confirmation: "",
  }).payload).toEqual({
    name: "Jane Tester",
    email: "jane@example.com",
    role: "tester",
  });
});

test.each([
  [{ current_password: "", new_password: "a-strong-password", new_password_confirmation: "a-strong-password" }, "current password"],
  [{ current_password: "current", new_password: "short", new_password_confirmation: "short" }, "between 12 and 128"],
  [{ current_password: "current", new_password: "a-strong-password", new_password_confirmation: "different" }, "do not match"],
])("validates self-service password changes", (input, message) => {
  expect(validatePasswordChange(input).error).toContain(message);
});

test("validates reset passwords without a current password", () => {
  expect(validateResetPassword({ token: "token", new_password: "a-strong-password", new_password_confirmation: "a-strong-password" }).payload.token).toBe("token");
  expect(validateResetPassword({ token: "token", new_password: "short", new_password_confirmation: "short" }).error).toContain("between 12 and 128");
});