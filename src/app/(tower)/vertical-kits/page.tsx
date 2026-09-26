// Management Control Tower (W033 shell) — the Vertical Kits surface
// (W092): the admin-managed catalog of vertical extension starter kits.
//
// WHAT THIS SURFACE SHOWS (all through the vertical-kits contract — the
// page itself is industry-blind and names no kit):
//   * the catalog of registered starter kits — versioned bundles of
//     extension manifests, the fail-closed permission footprint,
//     deep-action recipe templates, broker connection classes and the
//     honest metadata (industry, outcomes, what is NOT included);
//   * this company's installed kits, with the EXACT granted permissions
//     per manifest and the marketplace package bindings the installs
//     rode;
//   * the append-only lifecycle audit (install/upgrade/remove);
//   * the recipe-reference trail that survives kit removal (an honest
//     "this plan came from kit vX" instead of silent data loss).
//
// THE EDGE PATH renders its single honest status: PENDING W088. The
// Edge Connector is a separate in-flight work item; this surface
// validates and displays the expectation and never claims execution.

import Link from 'next/link';
import { resolvePageContext } from '../lib/page-context';
import {
  Badge,
  Card,
  Empty,
  Notice,
  NotScoped,
  StatTiles,
  StatusBadge,
  SurfaceHeader,
} from '../components/view-ui';
import { buildVerticalKitsView } from './lib/view';

export const dynamic = 'force-dynamic';

export default async function VerticalKitsPage() {
  const resolution = await resolvePageContext();
  if (!resolution.ok) return <NotScoped detail={resolution.detail} />;
  const view = await buildVerticalKitsView(resolution.context);

  const edgePending = view.catalog.kits.filter((kit) => kit.edge.recipes.length > 0);

  return (
    <>
      <SurfaceHeader
        title="Vertical kits"
        description="Starter kits for system-of-record-heavy industries: versioned bundles of extension manifests, permission-scoped deep-action recipe templates and broker connection classes. Kits install through the governed marketplace catalog and are granted exactly their declared footprint — removable, auditable, and industry-independent of Aurum core."
        meta={<>Generated {view.generatedAt}</>}
      />
      <StatTiles
        items={[
          { label: 'Registered kits', value: view.catalog.total },
          { label: 'Installed', value: view.installs.total },
          { label: 'Lifecycle events', value: view.events.total },
          { label: 'Recipe references', value: view.references.total },
        ]}
      />

      <Notice>
        The edge execution path is <strong>pending W088</strong>: kits may declare which recipes
        expect the Edge Connector, the declaration is validated and shown, but nothing executes
        over the edge at this base. Nothing on this surface claims otherwise.
      </Notice>

      <Card title="Kit catalog" meta={`${view.catalog.total} registered`}>
        {view.catalog.kits.length === 0 ? (
          <Empty title="No starter kits registered" />
        ) : (
          view.catalog.kits.map((kit) => (
            <section className="card-section" key={kit.kitKey}>
              <h3>
                {kit.industry} <span className="card-meta">{kit.kitKey} v{kit.version}</span>
              </h3>
              <p>{kit.description}</p>
              <table className="tt">
                <caption>{kit.industry} starter kit — bundle contents</caption>
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">What ships</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Permission footprint</td>
                    <td>
                      {kit.permissionFootprint.map((permission) => (
                        <Badge key={permission} kind="muted">
                          {permission}
                        </Badge>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td>Extension manifests</td>
                    <td>
                      {kit.manifests.map((manifest) => (
                        <div key={manifest.extensionKey}>
                          <strong>{manifest.extensionKey}</strong> v{manifest.version} —{' '}
                          {manifest.systemOfRecord}
                          {manifest.grantedPermissions.length > 0 ? (
                            <> · granted: {manifest.grantedPermissions.join(', ')}</>
                          ) : null}
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td>Deep-action recipes</td>
                    <td>
                      {kit.recipes.map((recipe) => (
                        <div key={recipe.recipeKey}>
                          <strong>{recipe.recipeKey}</strong> ({recipe.operationCount} operations
                          over {recipe.connectionKeys.join(', ')})
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td>Connection classes</td>
                    <td>
                      {kit.connections.map((connection) => (
                        <div key={connection.key}>
                          <strong>{connection.label}</strong> · {connection.brokerProvider} ·{' '}
                          {connection.capabilityClasses.join(', ')}
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <td>Edge execution</td>
                    <td>
                      <StatusBadge status={kit.edge.status} />
                      {kit.edge.recipes.length > 0 ? (
                        <> expects: {kit.edge.recipes.join(', ')}</>
                      ) : (
                        <> no recipe expects the edge</>
                      )}
                      <div className="card-meta">{kit.edge.note}</div>
                    </td>
                  </tr>
                  <tr>
                    <td>Intended outcomes</td>
                    <td>
                      <ul>
                        {kit.outcomes.map((outcome) => (
                          <li key={outcome}>{outcome}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                  <tr>
                    <td>Not included</td>
                    <td>
                      <ul>
                        {kit.notIncluded.map((boundary) => (
                          <li key={boundary}>{boundary}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                {kit.installedVersion === null ? (
                  <>
                    Not installed — the manifests must be INSTALLABLE in the{' '}
                    <Link href="/marketplace">marketplace</Link> before this company can install.
                  </>
                ) : (
                  <>Installed at v{kit.installedVersion}.</>
                )}
              </p>
            </section>
          ))
        )}
      </Card>

      <Card title="Installed kits" meta={`${view.installs.total} installed`}>
        {view.installs.items.length === 0 ? (
          <Empty title="No kits installed for this company" />
        ) : (
          <table className="tt">
            <caption>This company&apos;s installed vertical kits</caption>
            <thead>
              <tr>
                <th scope="col">Kit</th>
                <th scope="col">Version</th>
                <th scope="col">Granted per manifest</th>
                <th scope="col">Package bindings</th>
                <th scope="col">Installed</th>
              </tr>
            </thead>
            <tbody>
              {view.installs.items.map((install) => (
                <tr key={install.id}>
                  <td>{install.kitKey}</td>
                  <td>v{install.kitVersion}</td>
                  <td>
                    {install.grants.map((grant) => (
                      <div key={grant.id}>
                        {grant.extensionKey}: {grant.grantedPermissions.join(', ')}
                      </div>
                    ))}
                  </td>
                  <td>
                    {install.grants.map((grant) => (
                      <div key={grant.id}>{grant.packageKey}</div>
                    ))}
                  </td>
                  <td>{install.installedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Lifecycle audit" meta={`${view.events.total} events`}>
        {view.events.items.length === 0 ? (
          <Empty title="No kit lifecycle events yet" />
        ) : (
          <table className="tt">
            <caption>Append-only install / upgrade / remove trail</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Kit</th>
                <th scope="col">Versions</th>
                <th scope="col">Actor</th>
              </tr>
            </thead>
            <tbody>
              {view.events.items.map((event) => (
                <tr key={event.id}>
                  <td>{event.occurredAt}</td>
                  <td>
                    <StatusBadge status={event.eventType} />
                  </td>
                  <td>{event.kitKey}</td>
                  <td>
                    {event.fromVersion === null ? '—' : `v${event.fromVersion}`} →{' '}
                    {event.toVersion === null ? 'removed' : `v${event.toVersion}`}
                  </td>
                  <td>{event.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Recipe references" meta={`${view.references.total} recorded uses`}>
        {view.references.items.length === 0 ? (
          <Empty title="No recipe templates instantiated yet" />
        ) : (
          <table className="tt">
            <caption>
              Deep-action plans instantiated from kit recipes — they survive kit removal
            </caption>
            <thead>
              <tr>
                <th scope="col">Recipe</th>
                <th scope="col">Kit version</th>
                <th scope="col">Reference</th>
                <th scope="col">Kit state</th>
              </tr>
            </thead>
            <tbody>
              {view.references.items.map((reference) => (
                <tr key={reference.id}>
                  <td>{reference.recipeKey}</td>
                  <td>
                    {reference.kitKey} v{reference.kitVersion}
                  </td>
                  <td>{reference.reference}</td>
                  <td>
                    {reference.kitRemoved ? (
                      <Badge kind="warn">kit removed — reference retained</Badge>
                    ) : (
                      <Badge kind="ok">installed</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {edgePending.length > 0 ? (
        <Notice>
          {edgePending.length} kit{edgePending.length === 1 ? '' : 's'} declare edge-expecting
          recipes. Their expectation is validated data; execution waits for W088 and renders as
          pending-w088 everywhere.
        </Notice>
      ) : null}
    </>
  );
}
