import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "./i18n";
import { supabase } from "./supabase";

// undefined while the stored session is being read.
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

// app_metadata, since a user can edit their own user_metadata. RLS checks the same claim in the JWT.
export const isAdmin = (session: Session | null | undefined) => session?.user.app_metadata?.role === "admin";

export function Account({ session }: { session: Session }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <span className="min-w-0 break-all">{session.user.email}</span>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => supabase.auth.signOut()}>{t("로그아웃", "Log out")}</Button>
    </div>
  );
}

export function LoginForm({ title, description }: { title: string; description: string }) {
  const { t } = useT();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

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
  );
}
