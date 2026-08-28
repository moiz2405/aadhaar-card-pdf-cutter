'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'resume-maker:draft:v1';

const form = $('resume-form');
const sourceText = $('source-text');
const aiPanel = $('ai-panel');
const parseButton = $('parse-btn');
const parseStatus = $('parse-status');
const printButton = $('print-btn');
const clearButton = $('clear-btn');
const toast = $('resume-toast');
let parseProgressTimer = null;

const previewName = $('preview-name');
const previewHeadline = $('preview-headline');
const previewContact = $('preview-contact');
const previewSummarySection = $('preview-summary-section');
const previewSummary = $('preview-summary');
const previewSkillsSection = $('preview-skills-section');
const previewSkills = $('preview-skills');
const previewExperienceSection = $('preview-experience-section');
const previewExperience = $('preview-experience');
const previewEducationSection = $('preview-education-section');
const previewEducation = $('preview-education');
const previewProjectsSection = $('preview-projects-section');
const previewProjects = $('preview-projects');

function setParseStatus(message, state = 'idle') {
  parseStatus.textContent = message;
  parseStatus.classList.toggle('is-working', state === 'working');
  parseStatus.classList.toggle('parse-error', state === 'error');
  parseStatus.dataset.state = state;
  parseStatus.setAttribute('aria-busy', String(state === 'working'));
}

function startParseProgress() {
  const stages = [
    'Starting both AI providers…',
    'Both providers are reading your notes…',
    'Waiting for the first complete resume…',
    'Still working — checking the first usable result…',
  ];
  let stage = 0;
  setParseStatus(stages[stage], 'working');
  parseProgressTimer = window.setInterval(() => {
    stage = (stage + 1) % stages.length;
    setParseStatus(stages[stage], 'working');
  }, 2200);
}

function stopParseProgress() {
  if (parseProgressTimer !== null) {
    window.clearInterval(parseProgressTimer);
    parseProgressTimer = null;
  }
}

function blankExperience() {
  return { jobTitle: '', employer: '', location: '', startDate: '', endDate: '', bullets: [] };
}

function blankEducation() {
  return { degree: '', school: '', location: '', startDate: '', endDate: '' };
}

function blankProject() {
  return { name: '', description: '', link: '', bullets: [] };
}

function freshDraft() {
  return {
    fullName: '',
    headline: '',
    contact: { email: '', phone: '', location: '', linkedin: '', website: '' },
    summary: '',
    skills: [],
    experience: [blankExperience()],
    education: [blankEducation()],
    projects: [],
  };
}

function text(value, max = 3000) {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
}

function list(value, max = 30) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, 1000)).filter(Boolean).slice(0, max);
}

function normalizeDraft(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const contact = source.contact && typeof source.contact === 'object' ? source.contact : {};
  return {
    fullName: text(source.fullName, 160),
    headline: text(source.headline, 200),
    contact: {
      email: text(contact.email, 200),
      phone: text(contact.phone, 80),
      location: text(contact.location, 160),
      linkedin: text(contact.linkedin, 300),
      website: text(contact.website, 300),
    },
    summary: text(source.summary, 3000),
    skills: list(source.skills, 40),
    experience: Array.isArray(source.experience) ? source.experience.slice(0, 20).map((item) => ({
      jobTitle: text(item && item.jobTitle, 200),
      employer: text(item && item.employer, 200),
      location: text(item && item.location, 160),
      startDate: text(item && item.startDate, 80),
      endDate: text(item && item.endDate, 80),
      bullets: list(item && item.bullets, 12),
    })) : [],
    education: Array.isArray(source.education) ? source.education.slice(0, 20).map((item) => ({
      degree: text(item && item.degree, 200),
      school: text(item && item.school, 200),
      location: text(item && item.location, 160),
      startDate: text(item && item.startDate, 80),
      endDate: text(item && item.endDate, 80),
    })) : [],
    projects: Array.isArray(source.projects) ? source.projects.slice(0, 20).map((item) => ({
      name: text(item && item.name, 200),
      description: text(item && item.description, 1200),
      link: text(item && item.link, 300),
      bullets: list(item && item.bullets, 12),
    })) : [],
  };
}

let draft = loadDraft();
let saveTimer = null;
let toastTimer = null;

function loadDraft() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeDraft(JSON.parse(saved)) : freshDraft();
  } catch {
    return freshDraft();
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Private browsing or a full storage quota should not block editing.
    }
  }, 250);
}

function showToast(message, duration = 3000) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function makeField(labelText, key, value, options = {}) {
  const label = document.createElement('label');
  label.className = 'field';
  if (options.wide) label.classList.add('field-wide');

  const caption = document.createElement('span');
  caption.textContent = labelText;
  label.appendChild(caption);

  const control = document.createElement(options.multiline ? 'textarea' : 'input');
  control.dataset.itemKey = key;
  control.value = value || '';
  control.placeholder = options.placeholder || '';
  if (options.multiline) control.rows = options.rows || 4;
  else control.type = options.type || 'text';
  label.appendChild(control);
  return label;
}

function makeEntryHeader(title, type, index) {
  const header = document.createElement('div');
  header.className = 'repeat-item-head';

  const heading = document.createElement('h4');
  heading.textContent = `${title} ${index + 1}`;
  header.appendChild(heading);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-item';
  remove.dataset.remove = type;
  remove.dataset.index = String(index);
  remove.textContent = 'Remove';
  header.appendChild(remove);
  return header;
}

function renderCollection(type, items) {
  const container = $(`${type}-list`);
  container.replaceChildren();

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = type === 'projects' ? 'No projects added yet.' : `No ${type} added yet.`;
    container.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const entry = document.createElement('article');
    entry.className = 'repeat-item';
    entry.appendChild(makeEntryHeader(type === 'experience' ? 'Experience' : type === 'education' ? 'Education' : 'Project', type, index));

    const grid = document.createElement('div');
    grid.className = 'field-grid';
    if (type === 'experience') {
      grid.appendChild(makeField('Job title', 'jobTitle', item.jobTitle, { placeholder: 'Frontend Developer' }));
      grid.appendChild(makeField('Employer', 'employer', item.employer, { placeholder: 'Company name' }));
      grid.appendChild(makeField('Location', 'location', item.location, { placeholder: 'City or remote' }));
      grid.appendChild(makeField('Start date', 'startDate', item.startDate, { placeholder: 'Jan 2022' }));
      grid.appendChild(makeField('End date', 'endDate', item.endDate, { placeholder: 'Present' }));
      entry.appendChild(grid);
      entry.appendChild(makeField('Achievements and responsibilities', 'bullets', item.bullets.join('\n'), {
        multiline: true,
        rows: 5,
        wide: true,
        placeholder: 'One bullet per line',
      }));
    } else if (type === 'education') {
      grid.appendChild(makeField('Degree or qualification', 'degree', item.degree, { placeholder: 'B.Tech in Computer Science' }));
      grid.appendChild(makeField('School', 'school', item.school, { placeholder: 'University or institution' }));
      grid.appendChild(makeField('Location', 'location', item.location, { placeholder: 'City' }));
      grid.appendChild(makeField('Start date', 'startDate', item.startDate, { placeholder: '2018' }));
      grid.appendChild(makeField('End date', 'endDate', item.endDate, { placeholder: '2022' }));
      entry.appendChild(grid);
    } else {
      grid.appendChild(makeField('Project name', 'name', item.name, { placeholder: 'Project name' }));
      grid.appendChild(makeField('Link', 'link', item.link, { placeholder: 'github.com/you/project' }));
      entry.appendChild(grid);
      entry.appendChild(makeField('Description', 'description', item.description, {
        multiline: true,
        rows: 3,
        wide: true,
        placeholder: 'What you built and why it matters',
      }));
      entry.appendChild(makeField('Highlights', 'bullets', item.bullets.join('\n'), {
        multiline: true,
        rows: 4,
        wide: true,
        placeholder: 'One highlight per line',
      }));
    }
    container.appendChild(entry);
  });
}

function renderForm() {
  document.querySelector('[data-field="fullName"]').value = draft.fullName;
  document.querySelector('[data-field="headline"]').value = draft.headline;
  document.querySelector('[data-field="summary"]').value = draft.summary;
  document.querySelector('[data-field="skills"]').value = draft.skills.join(', ');
  document.querySelectorAll('[data-contact]').forEach((input) => {
    input.value = draft.contact[input.dataset.contact] || '';
  });
  renderCollection('experience', draft.experience);
  renderCollection('education', draft.education);
  renderCollection('projects', draft.projects);
}

function readCollection(type, keys) {
  return [...$(`${type}-list`).querySelectorAll('.repeat-item')].map((entry) => {
    const item = {};
    keys.forEach((key) => {
      const control = entry.querySelector(`[data-item-key="${key}"]`);
      item[key] = control ? text(control.value, key === 'description' ? 1200 : 1000) : '';
    });
    if (Object.prototype.hasOwnProperty.call(item, 'bullets')) {
      item.bullets = item.bullets.split(/\r?\n/).map((line) => text(line, 1000)).filter(Boolean).slice(0, 12);
    }
    return item;
  });
}

function syncDraftFromForm() {
  draft.fullName = text(document.querySelector('[data-field="fullName"]').value, 160);
  draft.headline = text(document.querySelector('[data-field="headline"]').value, 200);
  draft.summary = text(document.querySelector('[data-field="summary"]').value, 3000);
  draft.skills = document.querySelector('[data-field="skills"]').value
    .split(',')
    .map((item) => text(item, 100))
    .filter(Boolean)
    .slice(0, 40);
  document.querySelectorAll('[data-contact]').forEach((input) => {
    draft.contact[input.dataset.contact] = text(input.value, 300);
  });
  draft.experience = readCollection('experience', ['jobTitle', 'employer', 'location', 'startDate', 'endDate', 'bullets']);
  draft.education = readCollection('education', ['degree', 'school', 'location', 'startDate', 'endDate']);
  draft.projects = readCollection('projects', ['name', 'description', 'link', 'bullets']);
}

function hasContent(item) {
  return Object.values(item).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function setSection(section, content, hasValue) {
  section.classList.toggle('hidden', !hasValue);
  if (!hasValue) content.replaceChildren();
}

function addText(parent, tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.appendChild(node);
  return node;
}

function safeUrl(raw) {
  const value = text(raw, 300);
  if (!value) return '';
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function addContactValue(value, href, label) {
  const node = href ? document.createElement('a') : document.createElement('span');
  node.textContent = value;
  if (href) {
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener';
  }
  if (label) node.setAttribute('aria-label', label);
  previewContact.appendChild(node);
}

function renderContact() {
  previewContact.replaceChildren();
  const contact = draft.contact;
  const values = [];
  if (contact.email) values.push({ value: contact.email, href: `mailto:${contact.email}` });
  if (contact.phone) values.push({ value: contact.phone, href: `tel:${contact.phone.replace(/[^+\d]/g, '')}` });
  if (contact.location) values.push({ value: contact.location });
  if (contact.linkedin) values.push({ value: contact.linkedin, href: safeUrl(contact.linkedin) });
  if (contact.website) values.push({ value: contact.website, href: safeUrl(contact.website) });

  values.forEach((item, index) => {
    if (index) addText(previewContact, 'span', ' · ', 'contact-separator');
    addContactValue(item.value, item.href, item.value);
  });
}

function renderExperience() {
  previewExperience.replaceChildren();
  const items = draft.experience.filter(hasContent);
  items.forEach((item) => {
    const entry = document.createElement('article');
    entry.className = 'preview-entry';
    const title = item.jobTitle || item.employer;
    const heading = addText(entry, 'h3', title || 'Experience');
    if (item.jobTitle && item.employer) heading.appendChild(document.createTextNode(` · ${item.employer}`));
    const meta = [item.location, [item.startDate, item.endDate].filter(Boolean).join(' – ')].filter(Boolean).join('  |  ');
    if (meta) addText(entry, 'p', meta, 'preview-meta');
    if (item.bullets.length) {
      const listNode = document.createElement('ul');
      item.bullets.forEach((bullet) => addText(listNode, 'li', bullet));
      entry.appendChild(listNode);
    }
    previewExperience.appendChild(entry);
  });
  setSection(previewExperienceSection, previewExperience, items.length > 0);
}

function renderEducation() {
  previewEducation.replaceChildren();
  const items = draft.education.filter(hasContent);
  items.forEach((item) => {
    const entry = document.createElement('article');
    entry.className = 'preview-entry';
    const heading = addText(entry, 'h3', item.degree || item.school || 'Education');
    if (item.degree && item.school) heading.appendChild(document.createTextNode(` · ${item.school}`));
    const meta = [item.location, [item.startDate, item.endDate].filter(Boolean).join(' – ')].filter(Boolean).join('  |  ');
    if (meta) addText(entry, 'p', meta, 'preview-meta');
    previewEducation.appendChild(entry);
  });
  setSection(previewEducationSection, previewEducation, items.length > 0);
}

function renderProjects() {
  previewProjects.replaceChildren();
  const items = draft.projects.filter(hasContent);
  items.forEach((item) => {
    const entry = document.createElement('article');
    entry.className = 'preview-entry';
    const heading = addText(entry, 'h3', item.name || 'Project');
    if (item.link) {
      const href = safeUrl(item.link);
      const link = document.createElement('a');
      link.textContent = item.link;
      if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
      }
      heading.appendChild(document.createTextNode('  '));
      heading.appendChild(link);
    }
    if (item.description) addText(entry, 'p', item.description);
    if (item.bullets.length) {
      const listNode = document.createElement('ul');
      item.bullets.forEach((bullet) => addText(listNode, 'li', bullet));
      entry.appendChild(listNode);
    }
    previewProjects.appendChild(entry);
  });
  setSection(previewProjectsSection, previewProjects, items.length > 0);
}

function renderPreview() {
  previewName.textContent = draft.fullName || 'Your Name';
  previewHeadline.textContent = draft.headline;
  previewHeadline.classList.toggle('hidden', !draft.headline);
  renderContact();

  previewSummary.textContent = draft.summary;
  setSection(previewSummarySection, previewSummary, Boolean(draft.summary));
  previewSkills.textContent = draft.skills.join(' · ');
  setSection(previewSkillsSection, previewSkills, draft.skills.length > 0);
  renderExperience();
  renderEducation();
  renderProjects();
}

function setMode(mode) {
  document.querySelectorAll('.resume-mode').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  aiPanel.classList.toggle('hidden', mode !== 'ai');
}

function addItem(type) {
  syncDraftFromForm();
  draft[type].push(type === 'experience' ? blankExperience() : type === 'education' ? blankEducation() : blankProject());
  renderCollection(type, draft[type]);
  renderPreview();
  scheduleSave();
}

function removeItem(type, index) {
  syncDraftFromForm();
  draft[type].splice(index, 1);
  renderCollection(type, draft[type]);
  renderPreview();
  scheduleSave();
}

async function parseWithAI() {
  const textToParse = sourceText.value.trim();
  if (!textToParse) {
    showToast('Paste some information about yourself first.');
    sourceText.focus();
    return;
  }

  parseButton.disabled = true;
  startParseProgress();
  try {
    const response = await fetch('/api/parse-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textToParse }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error && payload.error.message ? payload.error.message : 'Could not parse the text.');
    draft = normalizeDraft(payload.resume);
    renderForm();
    renderPreview();
    scheduleSave();
    stopParseProgress();
    setParseStatus((payload.warnings && payload.warnings.length)
      ? payload.warnings.join(' ')
      : 'Parsed. Review the form before printing.', 'success');
    showToast('Details added to your resume. Review them before printing.', 4500);
  } catch (error) {
    stopParseProgress();
    const message = error.message || 'AI parsing failed. You can fill the form manually.';
    setParseStatus(message, 'error');
    showToast(message, 4500);
  } finally {
    stopParseProgress();
    parseButton.disabled = false;
  }
}

document.querySelectorAll('.resume-mode').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('input', () => {
  syncDraftFromForm();
  renderPreview();
  scheduleSave();
});
form.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add]');
  if (add) {
    event.preventDefault();
    addItem(add.dataset.add);
    return;
  }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    event.preventDefault();
    removeItem(remove.dataset.remove, Number(remove.dataset.index));
  }
});

parseButton.addEventListener('click', parseWithAI);

printButton.addEventListener('click', () => {
  syncDraftFromForm();
  if (!draft.fullName) {
    showToast('Add your name before printing.');
    document.querySelector('[data-field="fullName"]').focus();
    return;
  }
  scheduleSave();
  window.print();
});

clearButton.addEventListener('click', () => {
  if (!window.confirm('Clear this resume draft from the browser?')) return;
  draft = freshDraft();
  sourceText.value = '';
  stopParseProgress();
  setParseStatus('');
  renderForm();
  renderPreview();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore storage failures */ }
  showToast('Draft cleared.');
});

renderForm();
renderPreview();
