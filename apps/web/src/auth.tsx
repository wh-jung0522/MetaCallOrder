import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { supabase } from "./supabase";

export function RequireLogin({ children }: { children: (session: Session) => ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <p>불러오는 중…</p>;
  if (session) {
    return (
      <>
        <p className="muted">{session.user.email} · <button className="link" onClick={() => supabase.auth.signOut()}>로그아웃</button></p>
        {children(session)}
      </>
    );
  }

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const { error: failure } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setError(failure ? "이메일이나 비밀번호를 확인해 주세요." : "");
  };

  return (
    <form className="card login" onSubmit={login}>
      <label>이메일 <input name="email" type="email" required autoComplete="username" /></label>
      <label>비밀번호 <input name="password" type="password" required autoComplete="current-password" /></label>
      <button>로그인</button>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}
