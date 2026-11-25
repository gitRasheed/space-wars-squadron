import type { CapitalShipState, WorldState } from '../../src/sim/types';

/** The Saturn sortie's frigate; throws on a level that has none. */
export function frigateOf(world: Pick<WorldState, 'hostileFrigate'>): CapitalShipState {
  if (world.hostileFrigate === null) throw new Error('this level has no hostile frigate');
  return world.hostileFrigate;
}

export function capitalShipsOf(world: Pick<WorldState, 'friendlyCarrier' | 'hostileFrigate'>): readonly CapitalShipState[] {
  return world.hostileFrigate === null ? [world.friendlyCarrier] : [world.friendlyCarrier, world.hostileFrigate];
}
