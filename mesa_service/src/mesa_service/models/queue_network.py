"""A deterministic-when-seeded Mesa service-queue demonstration model."""

from __future__ import annotations

import math

import mesa


class QueueNetworkModel(mesa.Model):
    """A compact queue model suitable for exercising the Mesa service contract.

    Arrivals use seeded Bernoulli rounding of `arrival_rate`; service consumes a
    seeded queue with the configured capacity and average service duration. The
    metrics are operational demonstration outputs, not a validated real-world
    queueing model.
    """

    def __init__(
        self,
        *,
        arrival_rate: float = 6,
        service_capacity: int = 2,
        service_time: float = 1,
        initial_backlog: int = 0,
        seed: int | None = None,
    ) -> None:
        # The public model protocol accepts ``seed``; Mesa 3.5 prefers it as
        # the value of ``rng`` when initializing the framework generator.
        super().__init__(rng=seed)
        self.arrival_rate = float(arrival_rate)
        self.service_capacity = int(service_capacity)
        self.service_time = float(service_time)
        self.queue_length = int(initial_backlog)
        self.completed_jobs = 0
        self._total_wait_proxy = 0.0
        self.tick = 0

    def _rounded_arrivals(self) -> int:
        whole = math.floor(self.arrival_rate)
        return whole + int(self.random.random() < self.arrival_rate - whole)

    def step(self) -> None:
        self._total_wait_proxy += self.queue_length
        self.queue_length += self._rounded_arrivals()
        service_budget = self.service_capacity / self.service_time
        served = min(self.queue_length, math.floor(service_budget))
        if self.random.random() < service_budget - math.floor(service_budget):
            served = min(self.queue_length, served + 1)
        self.queue_length -= served
        self.completed_jobs += served
        self.tick += 1

    def snapshot(self) -> dict[str, int | float]:
        mean_wait = self._total_wait_proxy / self.completed_jobs if self.completed_jobs else 0.0
        return {
            "queue_length": self.queue_length,
            "completed_jobs": self.completed_jobs,
            "mean_wait_time": mean_wait,
        }
