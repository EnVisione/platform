import React, { useEffect, useState } from "react";
import {
  applicationRoles,
  communityOptions,
  formLimits,
} from "../shared/application-form.js";

const messages = {
  application_decision_role_required:
    "Only Managers and Founders with Dashboard access can edit application questions.",
  application_form_changed:
    "Someone saved changes while you were editing. Your changes are still here. Copy anything you need, then reload the latest version before saving again.",
  invalid_application_form:
    "Check the questions and scenarios. Each question needs a unique key, a title, and valid answer settings. Choice questions need 2–12 different answers. Keep one required scenario question and at least one scenario.",
};

export function ApplicationFormEditor({ csrf }) {
  const [catalog, setCatalog] = useState(null);
  const [role, setRole] = useState("community");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const [undo, setUndo] = useState(null);
  const dirty = Boolean(
    catalog && JSON.stringify(form) !== JSON.stringify(catalog.forms[role]),
  );
  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/application-forms");
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          messages[value.error] ||
            "Could not load application questions. Please try again.",
        );
      setCatalog(value);
      setForm(structuredClone(value.forms[role]));
      setUndo(null);
      setNotice("");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function change(next) {
    setForm(next);
    setNotice("");
    setError("");
  }
  function updateQuestion(index, patch) {
    change({
      ...form,
      questions: form.questions.map((question, i) =>
        i === index ? { ...question, ...patch } : question,
      ),
    });
  }
  function move(index, direction) {
    const questions = [...form.questions];
    [questions[index], questions[index + direction]] = [
      questions[index + direction],
      questions[index],
    ];
    change({ ...form, questions });
  }
  function remove(index) {
    setUndo({ question: form.questions[index], index });
    change({
      ...form,
      questions: form.questions.filter((_, i) => i !== index),
    });
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/application-forms", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ version: catalog.version, role, form }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          messages[value.error] ||
            "Could not save. Your changes are still here. Please try again.",
        );
      setCatalog(value);
      setForm(structuredClone(value.forms[role]));
      setUndo(null);
      setNotice(
        `${applicationRoles[role].label} saved. New applications will use these questions.`,
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="staff-applications application-form-editor">
      <a href="/applications">← Staff applications</a>
      <h2>Edit application questions</h2>
      <p>
        Edit each team’s questions, answer requirements, order, and scenario
        prompts. Changes apply to new applications. Existing drafts and
        submissions keep their original version.
      </p>
      <p className="apply-muted">
        Name, Minecraft and Discord identity, contact details, pronouns, age,
        timezone, weekly hours, community selection, and consent stay required
        where applicable. Applicants must remain 18 or older. The scenario
        response stays required.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="form-editor-saved" role="status">
          {notice}
        </p>
      )}
      {!catalog ? (
        <button type="button" onClick={load} disabled={busy}>
          {busy ? "Loading questions…" : "Retry loading"}
        </button>
      ) : (
        <>
          <nav className="form-editor-tabs" aria-label="Application forms">
            {Object.entries(applicationRoles).map(([key, value]) => (
              <button
                key={key}
                type="button"
                aria-pressed={role === key}
                disabled={busy || (dirty && key !== role)}
                onClick={() => {
                  setRole(key);
                  setForm(structuredClone(catalog.forms[key]));
                  setUndo(null);
                  setError("");
                  setNotice("");
                }}
              >
                {value.label}
              </button>
            ))}
          </nav>
          <div className="form-editor-toolbar">
            <span>
              Version {catalog.version} ·{" "}
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <button type="button" onClick={() => setPreview(!preview)}>
              {preview ? "Back to editing" : "Preview questions"}
            </button>
            <button type="button" disabled={busy} onClick={load}>
              Reload latest version
            </button>
            {dirty && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setForm(structuredClone(catalog.forms[role]));
                  setError("");
                  setNotice("");
                  setUndo(null);
                }}
              >
                Discard changes
              </button>
            )}
          </div>
          {dirty && (
            <p className="apply-muted">
              Save or discard your changes before switching applications.
              Reloading replaces your unsaved changes.
            </p>
          )}
          {preview ? (
            <div className="form-editor-preview">
              <h3>{applicationRoles[role].label}</h3>
              <p>{form.description}</p>
              {form.questions.map((question) => (
                <section className="application-response" key={question.key}>
                  <h3>
                    {question.title}
                    {question.required && (
                      <span className="apply-required" aria-label="required">
                        {" "}
                        *
                      </span>
                    )}
                  </h3>
                  <p>{question.help}</p>
                  <p className="apply-muted">
                    {question.kind === "choice"
                      ? `Choices: ${question.options.join(" / ")}`
                      : `${question.kind === "short" ? "Short answer" : "Paragraph"}, minimum ${question.minLength} characters when answered.`}{" "}
                    {question.condition !== "always" &&
                      `Shown when ${communityOptions.find(([key]) => key === question.condition)?.[1]} is selected.`}
                  </p>
                </section>
              ))}
            </div>
          ) : (
            <form onSubmit={save}>
              <fieldset disabled={busy} className="form-editor-fields">
                <label className="apply-field">
                  <span>
                    Application description{" "}
                    <span className="apply-required">*</span>
                  </span>
                  <textarea
                    required
                    maxLength={300}
                    rows={2}
                    value={form.description}
                    onChange={(event) =>
                      change({ ...form, description: event.target.value })
                    }
                  />
                </label>
                <h3>
                  Questions ({form.questions.length}/{formLimits.questions})
                </h3>
                <p>
                  Shared questions can be fine-tuned separately for each team.
                  Removing a question does not remove answers from submitted
                  applications.
                </p>
                {form.questions.map((question, index) => (
                  <details className="form-editor-question" key={question.key}>
                    <summary>
                      {index + 1}. {question.title || "New question"}{" "}
                      <span>{question.required ? "Required" : "Optional"}</span>
                    </summary>
                    <div className="form-editor-question-fields">
                      <label className="apply-field">
                        <span>
                          Question title{" "}
                          <span className="apply-required">*</span>
                        </span>
                        <input
                          required
                          maxLength={160}
                          value={question.title}
                          onChange={(event) =>
                            updateQuestion(index, { title: event.target.value })
                          }
                        />
                      </label>
                      <label className="apply-field">
                        <span>Help text</span>
                        <textarea
                          maxLength={1500}
                          rows={3}
                          value={question.help}
                          onChange={(event) =>
                            updateQuestion(index, { help: event.target.value })
                          }
                        />
                      </label>
                      <div className="form-editor-grid">
                        <label className="apply-field">
                          <span>Answer type</span>
                          <select
                            disabled={question.key === "scenarioAnswer"}
                            value={question.kind}
                            onChange={(event) =>
                              updateQuestion(index, {
                                kind: event.target.value,
                                minLength:
                                  event.target.value === "paragraph" ? 20 : 1,
                                options:
                                  event.target.value === "choice"
                                    ? ["Yes", "No"]
                                    : [],
                              })
                            }
                          >
                            <option value="paragraph">Paragraph</option>
                            <option value="short">Short answer</option>
                            <option value="choice">Choose one answer</option>
                          </select>
                        </label>
                        <label className="apply-field">
                          <span>Show this question</span>
                          <select
                            disabled={question.key === "scenarioAnswer"}
                            value={question.condition}
                            onChange={(event) =>
                              updateQuestion(index, {
                                condition: event.target.value,
                              })
                            }
                          >
                            <option value="always">Always</option>
                            {communityOptions.map(([key, label]) => (
                              <option key={key} value={key}>
                                When {label} is selected
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {question.kind === "choice" ? (
                        <label className="apply-field">
                          <span>Choices, one per line (2–12)</span>
                          <textarea
                            required
                            rows={4}
                            value={question.options.join("\n")}
                            onChange={(event) =>
                              updateQuestion(index, {
                                options: event.target.value.split("\n"),
                              })
                            }
                          />
                        </label>
                      ) : (
                        <label className="apply-field">
                          <span>Minimum answer length</span>
                          <input
                            required
                            type="number"
                            min={question.key === "scenarioAnswer" ? 40 : 1}
                            max={question.kind === "short" ? 300 : 4000}
                            step={1}
                            value={question.minLength}
                            onChange={(event) =>
                              updateQuestion(index, {
                                minLength: Number(event.target.value),
                              })
                            }
                          />
                        </label>
                      )}
                      <label className="apply-check">
                        <input
                          type="checkbox"
                          disabled={question.key === "scenarioAnswer"}
                          checked={question.required}
                          onChange={(event) =>
                            updateQuestion(index, {
                              required: event.target.checked,
                            })
                          }
                        />
                        <span>Answer required</span>
                      </label>
                      <div className="form-editor-actions">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          disabled={index === form.questions.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          Move down
                        </button>
                        <button
                          type="button"
                          className="form-editor-remove"
                          disabled={question.key === "scenarioAnswer"}
                          onClick={() => remove(index)}
                        >
                          Remove question
                        </button>
                      </div>
                    </div>
                  </details>
                ))}
                <div className="form-editor-actions">
                  <button
                    type="button"
                    disabled={form.questions.length >= formLimits.questions}
                    onClick={() =>
                      change({
                        ...form,
                        questions: [
                          ...form.questions,
                          {
                            key: `q_${crypto.randomUUID().replaceAll("-", "")}`,
                            title: "New question",
                            help: "",
                            kind: "paragraph",
                            required: true,
                            minLength: 20,
                            condition: "always",
                            options: [],
                          },
                        ],
                      })
                    }
                  >
                    Add question
                  </button>
                  {undo && (
                    <button
                      type="button"
                      onClick={() => {
                        const questions = [...form.questions];
                        questions.splice(
                          Math.min(undo.index, questions.length),
                          0,
                          undo.question,
                        );
                        change({ ...form, questions });
                        setUndo(null);
                      }}
                    >
                      Undo last removal
                    </button>
                  )}
                </div>
                <h3>
                  Scenario prompts ({form.scenarios.length}/
                  {formLimits.scenarios})
                </h3>
                <p>
                  Each applicant receives one randomly selected scenario. Their
                  assigned scenario stays the same while they complete the form.
                </p>
                {form.scenarios.map((scenario, index) => (
                  <div className="form-editor-scenario" key={index}>
                    <label className="apply-field">
                      <span>
                        Scenario {index + 1}{" "}
                        <span className="apply-required">*</span>
                      </span>
                      <textarea
                        required
                        maxLength={2000}
                        rows={4}
                        value={scenario}
                        onChange={(event) =>
                          change({
                            ...form,
                            scenarios: form.scenarios.map((value, i) =>
                              i === index ? event.target.value : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="form-editor-remove"
                      disabled={form.scenarios.length === 1}
                      onClick={() =>
                        change({
                          ...form,
                          scenarios: form.scenarios.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      Remove scenario {index + 1}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={form.scenarios.length >= formLimits.scenarios}
                  onClick={() =>
                    change({ ...form, scenarios: [...form.scenarios, ""] })
                  }
                >
                  Add scenario
                </button>
              </fieldset>
              <div className="form-editor-save">
                <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
                <button
                  className="apply-button apply-primary"
                  disabled={busy || !dirty}
                  type="submit"
                >
                  {busy ? "Saving…" : `Save ${applicationRoles[role].label}`}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
