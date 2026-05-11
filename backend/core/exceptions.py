class DomainError(Exception):
    pass


class StateTransitionError(DomainError):
    pass


class NotFoundError(DomainError):
    pass
