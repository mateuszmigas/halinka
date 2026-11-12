import { Button } from "@halinka/ui/components/button";
import { Card, CardContent } from "@halinka/ui/components/card";
import { useMutation } from "@tanstack/react-query";

import { GitHubMark } from "../gitHubMark";
import { logIn } from "./session";

const resultMessages: Record<string, string> = {
  refused: "An Admin of this server must add your GitHub user first.",
  failed: "The login failed. Try again.",
};

export const LoginPage = () => {
  const login = useMutation({ mutationFn: logIn });
  const result = new URLSearchParams(window.location.search).get("login");
  const message = login.error?.message ?? (result && resultMessages[result]);

  return (
    <main className="flex h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Halinka</h1>
          {message && <p className="text-destructive">{message}</p>}
          <Button
            variant="outline"
            className="w-full"
            disabled={login.isPending}
            onClick={() => login.mutate()}
          >
            <GitHubMark className="size-4" />
            Log in with GitHub
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};
