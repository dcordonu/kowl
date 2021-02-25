import { Broker, Partition, TopicDetail } from "../../../state/restInterfaces";
import { api } from "../../../state/backendApi";
import { toJson } from "../../../utils/utils";

// Requirements:
// 1. Each replica must be on a different broker (unless replicationFactor < brokerCount makes it impossible).
// 2. Partitions should be balanced as evenly as possible across the brokers

// Optimization:
// If, while we're looking for a broker to assigning a replica to, we find there are multiple "good" brokers, we can
// optimize according to the following priority list.
//   1. rack: try to stay within the same rack, maybe even the same broker (is that neccesary?)
//   2. partition count, brokers should have roughly the same number of replicas (need to get all topics, all their partitions to even know which broker has which partitions)
//   3. disk space, only if partition count is equal and can't help us decide

// also optimize network traffic: that means trying to stay "inter rack" (bc that traffic is mostly free)
//
// maybe "unassign" all replicas, subtracing used disk space from that broker,
// then, from a fresh start, assign preferably to the original broker, or to a broker in the same rack, or ... (using optimization priorities)


// Input for a reassignment computation. A selection of partitions that should be reassigned.
export type TopicPartitions = {
    topic: TopicDetail // topic the partitions belong to
    partitions: Partition[], // selected partitions
}

// Result of a reassignment computation. Tells you what brokers to use for each partition in each topic.
export type TopicAssignments = {
    [topicName: string]: {
        [partitionId: number]: PartitionAssignments
    }
};
export type PartitionAssignments = {
    partition: Partition,
    brokers: Broker[] // brokers the replicas are on; meaning length is always equal to the replicationFactor
};

type BrokerReplicaCount = { // track how many replicas were assigned to a broker (over all partitions)
    broker: ExBroker;
    assignedReplicas: number;
};


export function computeReassignments(selectedTopicPartitions: TopicPartitions[], allBrokers: Broker[], targetBrokers: Broker[]): TopicAssignments {
    // Track information like used disk space per broker, so we extend each broker with some metadata
    const allExBrokers = allBrokers.map(b => new ExBroker(b));
    const targetExBrokers = allExBrokers.filter(exb => targetBrokers.find(b => exb.brokerId == b.brokerId) != undefined);

    const resultAssignments: TopicAssignments = {};
    for (const t of selectedTopicPartitions) {
        resultAssignments[t.topic.topicName] = {};
        for (const partition of t.partitions)
            resultAssignments[t.topic.topicName][partition.id] = { partition: partition, brokers: [] };
    }

    // 1. Reset
    // For the sake of calculation, it is easier to start with a fresh slate.
    // So we first 'virtually' remove these assignments by going through each replica
    // and subtracting its size(disk space) from broker it is on.
    for (const broker of targetExBrokers)
        for (const t of selectedTopicPartitions)
            broker.adjustTracking(t.partitions, 'remove');

    // 2. Distribute
    // Go through each topic, assign the replicas of its partitions to the brokers
    for (const topicPartitions of selectedTopicPartitions) {
        if (topicPartitions.topic.replicationFactor <= 0) continue; // must be an error?
        if (topicPartitions.partitions.length == 0) continue; // no partitions to be reassigned in this topic

        computeTopicAssignments(topicPartitions, targetExBrokers, allExBrokers, resultAssignments[topicPartitions.topic.topicName]);
    }

    return resultAssignments;
}

// Compute, for the partitions of a single topic, to which brokers their replicas should be assigned to.
function computeTopicAssignments(
    topicPartitions: TopicPartitions,
    targetBrokers: ExBroker[],
    allBrokers: ExBroker[],
    resultAssignments: { [partitionId: number]: PartitionAssignments; },
) {
    const { topic, partitions } = topicPartitions;

    // shouldn't happen, if the user didn't select any partitions, the entry for that topic shouldn't be there either
    if (partitions.length == 0) return;

    const replicationFactor = topic.replicationFactor;
    if (replicationFactor <= 0) return; // normally it shouldn't be possible; every topic must have at least 1 replica for each of its partitions

    // todo: two phase approach? first assign only one replica for the partition, then assign the remaining replicas

    // Track how many replicas (of this topic, ignoring from which partitions exactly) were assigned to each broker
    const brokerReplicaCount: BrokerReplicaCount[] = targetBrokers.map(b => ({ broker: b, assignedReplicas: 0 }));

    // For each partition, distribute the replicas to the brokers.
    for (const partition of partitions) {
        // Determine what broker for which replica
        const replicaAssignments = computeReplicaAssignments(partition, replicationFactor, brokerReplicaCount, allBrokers);

        resultAssignments[partition.id].brokers = replicaAssignments;
    }
}

function computeReplicaAssignments(partition: Partition, replicas: number, brokerReplicaCount: BrokerReplicaCount[], allBrokers: ExBroker[]): ExBroker[] {
    const resultBrokers: ExBroker[] = []; // result
    const sourceBrokers = partition.replicas.map(id => allBrokers.first(b => b.brokerId == id)!);
    if (sourceBrokers.any(x => x == null)) throw new Error(`replicas of partition ${partition.id} (${toJson(partition.replicas)}) define a brokerId which can't be found in 'allBrokers': ${toJson(allBrokers.map(b => ({ id: b.brokerId, address: b.address, rack: b.rack })))}`);
    const sourceRacks = sourceBrokers.map(b => b.rack).distinct();

    // todo:
    // The current approach is "greedy" in that it just wants to assign a replica to whatever broker.
    // But because of 'example#2' it is possible that we'll end up causing a lot of network traffic that
    // could have been avoided if we had just the two brokers.

    // A better appraoch would be to find the best broker for each replica, but instead of commiting to that immediately,
    // we'd first save that as a "pending" assignment, along with a score of how much work that assignment would be.
    // That'd give us a list of pending assignments, which we can sort by their score.
    // To determine that score we'd just re-use the first two very simple metrics (same broker is best: score=2, and same rack is almost as good: score=1)

    for (let i = 0; i < replicas; i++) {
        // For each replica to be assigned, we create a set of potential brokers.
        // The potential brokers are those that have least assignments from this partition.
        // If we'd only assign based on the additional metrics, all replicas would be assigned to only one broker (which would be bad if rf=1)
        brokerReplicaCount.sort((a, b) => a.assignedReplicas - b.assignedReplicas);
        const minAssignments = brokerReplicaCount[0].assignedReplicas;
        const potential = brokerReplicaCount.filter(b => b.assignedReplicas == minAssignments);

        // Multiple brokers, sort by additional metrics
        if (potential.length > 1) {
            potential.sort((a, b) => {
                // 1. try same broker as before
                const aIsSame = sourceBrokers.includes(a.broker);
                const bIsSame = sourceBrokers.includes(b.broker);
                if (aIsSame && !bIsSame) return -1;
                if (bIsSame && !aIsSame) return 1;

                // 2. Neither of the two brokers previously hosted this partition
                //    But maybe one of them is in the same rack as one of the source brokers?
                const aIsSameRack = sourceRacks.includes(a.broker.rack);
                const bIsSameRack = sourceRacks.includes(b.broker.rack);
                if (aIsSameRack && !bIsSameRack) return -1;
                if (bIsSameRack && !aIsSameRack) return 1;

                // 3. Neither of the given brokers is in the same rack as any source broker.
                //    So we decide by which broker has the fewest total partitions/replicas assigned to it.
                const replicasOnA = a.broker.initialReplicas + a.broker.assignedReplicas;
                const replicasOnB = b.broker.initialReplicas + b.broker.assignedReplicas;
                if (replicasOnA < replicasOnB) return -1;
                if (replicasOnB < replicasOnA) return 1;

                // 4. Both brokers actually have the same number of assigned replicas!
                //    But maybe one of them uses less disk space than the other?
                const diskOnA = a.broker.initialSize + a.broker.assignedSize;
                const diskOnB = a.broker.initialSize + b.broker.assignedSize;
                if (diskOnA < diskOnB) return -1;
                if (diskOnB < diskOnA) return 1;

                // They're identical, so it doesn't matter which one we use.
                return 0;
            });
        }

        // Take the best broker
        potential[0].assignedReplicas++; // increase temporary counter (which only tracks assignments within the topic)
        const bestBroker = potential[0].broker;
        resultBrokers.push(bestBroker);

        // increase total number of assigned replicas
        bestBroker.assignedReplicas++;
        // The new assignment will take up disk space, which must be tracked as well.
        // However, one of the brokers could be reporting disk usage that is smaller than it really is,
        // because it was just recently assigned this replica and is still in the process of receiving data from the other brokers.
        // That's why we're using the largest reported size as our estimation for how much space the assignment will end up using.
        const replicaSize = partition.partitionLogDirs.max(e => e.size);
        bestBroker.assignedSize += replicaSize;
    }

    return resultBrokers;
}


// Broker extended with tracking information.
// Used to quickly determine which is the best broker for a given replica, without having to recompute the tracked information all the time
// (Otherwise we'd have to iterate over every topic/partition/replica all the time)
class ExBroker implements Broker {
    brokerId: number;
    logDirSize: number;
    address: string;
    rack: string;

    // Values as they actually are currently in the cluster
    actualReplicas: number = 0; // number of all replicas (no matter from which topic) assigned to this broker
    actualSize: number = 0; // total size used by all the replicas assigned to this broker

    // 'actual' values minus everything that is to be reassigned
    // in other words: the state of the broker without counting anything we're about to reassign
    initialReplicas: number = 0;
    initialSize: number = 0;

    // values of the current assignments
    // counting only whenever we assign something to this broker
    assignedReplicas: number = 0;
    assignedSize: number = 0;

    constructor(sourceBroker: Broker) {
        Object.assign(this, sourceBroker);
        this.recomputeActual();
    }

    recomputeActual() {
        this.actualReplicas = 0;
        this.actualSize = 0;

        if (api.topicPartitions == null)
            throw new Error(`cannot recompute actual usage of broker '${this.brokerId}' because 'api.topicPartitions == null' (no permissions?)`);

        for (const [topic, partitions] of api.topicPartitions) {
            if (partitions == null) throw new Error(`cannot recompute actual usage of broker '${this.brokerId}' for topic '${topic}', because 'partitions == null' (no permissions?)`);

            for (const p of partitions) {
                // replicas
                const replicasAssignedToThisBroker = p.replicas.count(x => x == this.brokerId);
                this.actualReplicas += replicasAssignedToThisBroker;

                // size: using 'first()' because each broker has exactly one entry (or maybe zero if broker is offline)
                const logDirEntry = p.partitionLogDirs.first(x => x.error == "" && x.brokerId == this.brokerId);
                if (logDirEntry !== undefined)
                    this.actualSize += logDirEntry.size;
                else {
                    // todo:
                    // - fallback to another entry? (using maximum size we find)
                    // - throw error?
                }
            }
        }
    }

    adjustTracking(partitions: Partition[], mode: 'add' | 'remove') {
        let deltaSize = 0;
        let deltaReplicas = 0;
        for (const p of partitions) {
            const logDirEntry = p.partitionLogDirs.first(x => x.error == "" && x.brokerId == this.brokerId && x.partitionId == p.id);
            if (logDirEntry === undefined) throw new Error('cannot find matching partitionLogDir entry: ' + toJson({ partition: p, exBroker: this }, 4));
            deltaSize += logDirEntry.size;

            deltaReplicas += p.replicas.count(id => id == this.brokerId);
        }

        if (mode == 'add') {
            // this.trackedReplicas += deltaReplicas;
            // this.trackedSize += deltaSize;
        } else {
            // this.trackedReplicas -= deltaReplicas;
            // this.trackedSize -= deltaSize;
        }
    }
}