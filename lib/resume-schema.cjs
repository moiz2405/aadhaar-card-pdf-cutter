'use strict';

const MAX_RESUME_INPUT_CHARS = 20000;

const stringSchema = { type: 'string' };
const stringListSchema = {
  type: 'array',
  items: stringSchema,
};

// The schema is intentionally flat and conservative. Every property is
// required so strict structured-output providers can always return a stable
// object; unknown values are represented by empty strings or arrays.
const RESUME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullName: stringSchema,
    headline: stringSchema,
    contact: {
      type: 'object',
      additionalProperties: false,
      properties: {
        email: stringSchema,
        phone: stringSchema,
        location: stringSchema,
        linkedin: stringSchema,
        website: stringSchema,
      },
      required: ['email', 'phone', 'location', 'linkedin', 'website'],
    },
    summary: stringSchema,
    skills: stringListSchema,
    experience: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobTitle: stringSchema,
          employer: stringSchema,
          location: stringSchema,
          startDate: stringSchema,
          endDate: stringSchema,
          bullets: stringListSchema,
        },
        required: ['jobTitle', 'employer', 'location', 'startDate', 'endDate', 'bullets'],
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          degree: stringSchema,
          school: stringSchema,
          location: stringSchema,
          startDate: stringSchema,
          endDate: stringSchema,
        },
        required: ['degree', 'school', 'location', 'startDate', 'endDate'],
      },
    },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: stringSchema,
          description: stringSchema,
          link: stringSchema,
          bullets: stringListSchema,
        },
        required: ['name', 'description', 'link', 'bullets'],
      },
    },
  },
  required: [
    'fullName',
    'headline',
    'contact',
    'summary',
    'skills',
    'experience',
    'education',
    'projects',
  ],
};

function emptyResume() {
  return {
    fullName: '',
    headline: '',
    contact: {
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      website: '',
    },
    summary: '',
    skills: [],
    experience: [],
    education: [],
    projects: [],
  };
}

function cleanText(value, maxLength = 2000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function cleanList(value, maxItems = 30) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => cleanText(item, 1000))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeResume(value) {
  const source = cleanObject(value);
  const contact = cleanObject(source.contact);
  const resume = emptyResume();

  resume.fullName = cleanText(source.fullName, 160);
  resume.headline = cleanText(source.headline, 200);
  resume.contact.email = cleanText(contact.email, 200);
  resume.contact.phone = cleanText(contact.phone, 80);
  resume.contact.location = cleanText(contact.location, 160);
  resume.contact.linkedin = cleanText(contact.linkedin, 300);
  resume.contact.website = cleanText(contact.website, 300);
  resume.summary = cleanText(source.summary, 3000);
  resume.skills = cleanList(source.skills, 40);

  if (Array.isArray(source.experience)) {
    resume.experience = source.experience.slice(0, 20).map((item) => {
      const entry = cleanObject(item);
      return {
        jobTitle: cleanText(entry.jobTitle, 200),
        employer: cleanText(entry.employer, 200),
        location: cleanText(entry.location, 160),
        startDate: cleanText(entry.startDate, 80),
        endDate: cleanText(entry.endDate, 80),
        bullets: cleanList(entry.bullets, 12),
      };
    });
  }

  if (Array.isArray(source.education)) {
    resume.education = source.education.slice(0, 20).map((item) => {
      const entry = cleanObject(item);
      return {
        degree: cleanText(entry.degree, 200),
        school: cleanText(entry.school, 200),
        location: cleanText(entry.location, 160),
        startDate: cleanText(entry.startDate, 80),
        endDate: cleanText(entry.endDate, 80),
      };
    });
  }

  if (Array.isArray(source.projects)) {
    resume.projects = source.projects.slice(0, 20).map((item) => {
      const entry = cleanObject(item);
      return {
        name: cleanText(entry.name, 200),
        description: cleanText(entry.description, 1200),
        link: cleanText(entry.link, 300),
        bullets: cleanList(entry.bullets, 12),
      };
    });
  }

  return resume;
}

module.exports = {
  MAX_RESUME_INPUT_CHARS,
  RESUME_SCHEMA,
  emptyResume,
  normalizeResume,
};
