import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function SplashPage() {
  const { features, isLoading } = useAuth();

  return (
    <div className="page">
      <div className="bg" aria-hidden="true" />
      <div className="sparkles" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <header className="header">
        <div className="brand">
          <div className="logo">prism0</div>
          <div className="tag">ideas → apps, with a little sparkle</div>
        </div>
        <nav className="headerNav">
          {!isLoading && features.loginEnabled ? (
            <>
              <Link className="pillLink" to="/login">
                Log in
              </Link>
              <Link className="btn btnSmall" to="/register">
                Create account
              </Link>
            </>
          ) : null}
        </nav>
      </header>

      <main className="splashMain">
        <section className="splashHero card">
          <h1>Turn prompts into polished browser apps</h1>
          <p>
            prism0 generates small HTML/CSS/JS projects with live progress, validation, editing,
            hosting, and export. Describe an idea, iterate with follow-up prompts, publish a unique
            URL, and manage versions from your dashboard.
          </p>
          <div className="splashActions">
            {!isLoading && features.loginEnabled ? (
              <>
                <Link className="btn" to="/register">
                  Get started
                </Link>
                <Link className="pillLink" to="/login">
                  I already have an account
                </Link>
              </>
            ) : (
              <Link className="btn" to="/app">
                Open generator
              </Link>
            )}
          </div>
        </section>

        <section className="splashGrid">
          <article className="card splashCard">
            <h2>Generate & validate</h2>
            <p>LLM output is linted and tested before it reaches your editor and preview.</p>
          </article>
          <article className="card splashCard">
            <h2>Iterate safely</h2>
            <p>Follow-up prompts, runtime repair, and validation repair keep apps improving.</p>
          </article>
          <article className="card splashCard">
            <h2>Host & track</h2>
            <p>Publish unique URLs, monitor page views, revert versions, and manage projects.</p>
          </article>
        </section>
      </main>
    </div>
  );
}
