const { readFileSync, writeFileSync } = require("node:fs");

function patchAccount(source) {
  const start = "loginInfo = await (0, import_account.joinWithProvider)(";
  const oldArgument =
    "\n            socialKey,\n            signUpDisabled\n          );";
  const newArgument =
    "\n            socialKey,\n            false\n          );";
  const position = source.indexOf(start);
  if (position < 0 || source.indexOf(start, position + start.length) !== -1) {
    throw new Error(
      "Expected one invited provider login in the pinned Huly account image",
    );
  }
  const end = source.indexOf("\n          );", position);
  if (end < 0) throw new Error("Invited provider login is incomplete");
  const call = source.slice(position, end + "\n          );".length);
  if (
    !call.includes(oldArgument) ||
    call.indexOf(oldArgument) !== call.lastIndexOf(oldArgument)
  ) {
    throw new Error(
      "Pinned Huly account image no longer matches the invite patch",
    );
  }
  const method = "        ensurePerson: (0, import_utils6.wrap)(ensurePerson),";
  if (
    !source.includes(method) ||
    source.indexOf(method) !== source.lastIndexOf(method)
  ) {
    throw new Error(
      "Pinned Huly account image no longer matches the staff account patch",
    );
  }
  const provision = `        ensureStaffAccount: (0, import_utils6.wrap)(require('/usr/src/app/drakora-staff-account.cjs')({
          decodeToken: import_server_token.decodeTokenVerbose,
          verifyServices: import_utils6.verifyAllowedServices,
          loginWithProvider: import_utils6.loginOrSignUpWithProvider
        })),`;
  return (
    source.slice(0, position) +
    call.replace(oldArgument, newArgument) +
    source.slice(position + call.length)
  ).replace(method, `${method}\n${provision}`);
}

module.exports = { patchAccount };
if (require.main === module) {
  const path = "/usr/src/app/bundle.js";
  writeFileSync(path, patchAccount(readFileSync(path, "utf8")));
}
