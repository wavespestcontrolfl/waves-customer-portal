import { Input, Select } from "../ui";

export default function CustomerHealthFilters({ value, onChange }) {
  const set = (key, next) => onChange((current) => ({ ...current, [key]: next }));
  return <fieldset className="m-0 mb-5 min-w-0 border-0 border-b border-solid border-zinc-200 p-0 pb-5">
    <legend className="mb-3 text-16 font-medium text-ink-primary">Health & retention</legend>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-14 text-ink-secondary">Health grade
        <Select className="mt-1 !text-16 md:!text-14" value={value.healthGrade || ""} onChange={(event) => set("healthGrade", event.target.value)}>
          <option value="">Any grade</option>
          {["A", "B", "C", "D", "F"].map((grade) => <option key={grade} value={grade}>Grade {grade}</option>)}
          <option value="ungraded">Grade not recorded</option>
        </Select>
      </label>
      <label className="text-14 text-ink-secondary">Health / churn risk
        <Select className="mt-1 !text-16 md:!text-14" value={value.healthRisk || ""} onChange={(event) => set("healthRisk", event.target.value)}>
          <option value="">Any risk</option>
          <option value="low">Healthy / low risk</option>
          <option value="moderate">Watch / moderate risk</option>
          <option value="high">At risk / high risk</option>
          <option value="critical">Critical risk</option>
          <option value="at_risk">High or critical risk</option>
        </Select>
      </label>
      <label className="text-14 text-ink-secondary">Minimum health score
        <Input className="mt-1 !text-16 md:!text-14" type="number" min="0" max="100" placeholder="0" value={value.minHealthScore || ""} onChange={(event) => set("minHealthScore", event.target.value)} />
      </label>
      <label className="text-14 text-ink-secondary">Maximum health score
        <Input className="mt-1 !text-16 md:!text-14" type="number" min="0" max="100" placeholder="100" value={value.maxHealthScore || ""} onChange={(event) => set("maxHealthScore", event.target.value)} />
      </label>
      <label className="text-14 text-ink-secondary sm:col-span-2">30-day churn probability
        <Select className="mt-1 !text-16 md:!text-14" value={value.minChurnProbability || ""} onChange={(event) => set("minChurnProbability", event.target.value)}>
          <option value="">Any, including no forecast</option>
          <option value="0">Has a recorded forecast</option>
          <option value="25">25% or higher</option>
          <option value="50">50% or higher</option>
          <option value="75">75% or higher</option>
        </Select>
      </label>
      <label className="text-14 text-ink-secondary sm:col-span-2">Retention outcome
        <Select className="mt-1 !text-16 md:!text-14" value={value.retention || ""} onChange={(event) => set("retention", event.target.value)}>
          <option value="">Any outcome</option>
          <option value="outreach_sent">Outreach sent</option>
          <option value="saved">Customer saved</option>
          <option value="revenue_saved">Revenue saved</option>
          <option value="upsell_accepted">Upsell accepted</option>
          <option value="upsell_revenue">Upsell with recorded revenue</option>
        </Select>
      </label>
    </div>
    <p className="mt-2 text-14 text-ink-tertiary">Retention outcomes use records created in the last 30 days.</p>
  </fieldset>;
}
