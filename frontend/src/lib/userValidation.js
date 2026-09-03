export const USER_ROLES = ["admin", "qa_manager", "tester", "developer", "viewer"];
export const USER_ROLE_LABELS = {
  admin: "Administrator",
  qa_manager: "QA Manager",
  tester: "Tester",
  developer: "Developer",
  viewer: "Viewer",
};

export function userRoleLabel(role) {
  return USER_ROLE_LABELS[role] || role || "Unknown role";
}

export function validateNewUser(input, existingUsers = []) {
  const payload = {
    name: (input.name || "").trim(),
    email: (input.email || "").trim().toLowerCase(),
    role: input.role,
    active: Boolean(input.active),
    send_welcome_email: input.send_welcome_email !== false,
  };
  if (!payload.name) return { error: "Name is required" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return { error: "Enter a valid email address" };
  }
  if (!USER_ROLES.includes(payload.role)) return { error: "Choose a permitted role" };
  if (existingUsers.some((user) => user.email?.trim().toLowerCase() === payload.email)) {
    return { error: "Another user already uses this email" };
  }
  return { payload };
}

export function validateUserEdit(input) {
  const name = (input.name || "").trim();
  const email = (input.email || "").trim().toLowerCase();
  if (!name) return { error: "Name is required" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address" };
  }
  if (!USER_ROLES.includes(input.role)) return { error: "Choose a permitted role" };
  return {
    payload: {
      name,
      email,
      role: input.role,
    },
  };
}

export function validatePasswordChange(input) {
  const currentPassword = input.current_password || "";
  const newPassword = input.new_password || "";
  if (!currentPassword) return { error: "Enter your current password" };
  if (newPassword.length < 12 || newPassword.length > 128) {
    return { error: "New password must be between 12 and 128 characters" };
  }
  if (newPassword !== (input.new_password_confirmation || "")) {
    return { error: "New passwords do not match" };
  }
  return { payload: { current_password: currentPassword, new_password: newPassword, new_password_confirmation: input.new_password_confirmation } };
}

export function validateResetPassword(input) {
  const password = input.new_password || "";
  if (password.length < 12 || password.length > 128) {
    return { error: "Password must be between 12 and 128 characters" };
  }
  if (password !== (input.new_password_confirmation || "")) {
    return { error: "New passwords do not match" };
  }
  return { payload: { token: input.token || "", new_password: password, new_password_confirmation: input.new_password_confirmation } };
}

export function activeAssignableUsers(users = []) {
  return users.filter((user) => user.active !== false && !user.deleted_at);
}

export function filterUsersByStatus(users = [], status = "active") {
  if (status === "all") return users;
  const active = status === "active";
  return users.filter((user) => (user.active !== false) === active);
}