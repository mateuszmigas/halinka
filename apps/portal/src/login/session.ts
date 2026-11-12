const postJson = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const logIn = async () => {
  const answer = await postJson("/api/auth/sign-in/social", {
    provider: "github",
    callbackURL: `${window.location.pathname}${window.location.search}`,
  });
  if (!answer.ok) throw new Error("The server did not start the login. Try again.");
  const { url } = (await answer.json()) as { url: string };
  window.location.assign(url);
};

export const logOut = async () => {
  await postJson("/api/auth/sign-out", {});
  window.location.assign("/");
};
