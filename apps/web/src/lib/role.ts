/**
 * Who the signed-in person is in the organization they're acting in. A Watcher sees everything
 * about progress and changes nothing; the API enforces that, and the app says so up front.
 */
export interface Role {
  organization: string | null;
  role: 'director' | 'watcher';
  /** One of Icreon's administrators (a Director of Icreon): the pages every licensee shares. */
  superAdmin: boolean;
  /** The organization the app shows. */
  organizationId: string | null;
  /** Every organization the person belongs to, for the switcher. */
  organizations: { id: string; name: string; role: 'director' | 'watcher' }[];
}

// Without organizations (an older API, or a local run) the person runs everything, as before.
let current: Role = {
  organization: null,
  role: 'director',
  superAdmin: true,
  organizationId: null,
  organizations: [],
};

export const role = (): Role => current;
export const isWatching = () => current.role === 'watcher';

/** What the app answers a Watcher's attempt to change something (the API's own words). */
export const readOnlyMessage = () =>
  `You are watching${current.organization ? ` ${current.organization}` : ''}: you can see everything, but not change it.`;

/**
 * Reads the role once, before the app renders. An API without organizations (or one that
 * can't be reached yet) leaves the person a Director, as before.
 */
export async function loadRole(api: string): Promise<Role> {
  try {
    const res = await fetch(`${api}/me/organizations`, { credentials: 'include' });
    if (res.ok) {
      const body = (await res.json()) as {
        current: {
          id: string;
          name: string;
          role: 'director' | 'watcher';
          superAdmin?: boolean;
        } | null;
        organizations?: { id: string; name: string; role: 'director' | 'watcher' }[];
      };
      if (body.current)
        current = {
          organization: body.current.name,
          role: body.current.role,
          superAdmin: body.current.superAdmin ?? false,
          organizationId: body.current.id,
          organizations: body.organizations ?? [],
        };
    }
  } catch {
    /* keep the default */
  }
  document.documentElement.dataset.role = current.role;
  return current;
}
