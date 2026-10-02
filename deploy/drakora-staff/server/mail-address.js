const pattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export const validMailAddress = (value) =>
  typeof value === "string" && value.length <= 254 && pattern.test(value);
