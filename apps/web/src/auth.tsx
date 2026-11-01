import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "./i18n";
import { supabase } from "./supabase";

interface Props {
  title: string;
  description: string;
  children: (session: Session) => ReactNode;
}

export function RequireLogin({ title, description, children }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const { t } = useT();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (session) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{session.user.email}</span>
            <Button variant="outline" size="sm" onClick={() => supabase.auth.signOut()}>{t("로그아웃", "Log out")}</Button>
          </div>
        </div>
        {children(session)}
      </div>
    );
  }

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: failure } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    setError(Boolean(failure));
  };

  return (
    <div className="flex flex-1 items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={login}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">{t("이메일", "Email")}</FieldLabel>
                <Input id="email" name="email" type="email" required autoComplete="username" />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">{t("비밀번호", "Password")}</FieldLabel>
                <Input id="password" name="password" type="password" required autoComplete="current-password" />
              </Field>
              {error && <Alert variant="destructive"><AlertDescription>{t("이메일이나 비밀번호가 맞지 않습니다. 다시 입력해 주세요.", "That email or password is not right. Please try again.")}</AlertDescription></Alert>}
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                {t("로그인", "Log in")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
