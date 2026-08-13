import re
import asyncio
import collections
from dataclasses import dataclass, field
from typing import Dict, List, Callable, Any

# =====================================================================
# 1. Message Protocol Dataclasses
# =====================================================================

@dataclass
class Question:
    content: str

@dataclass
class Answer:
    content: str

@dataclass
class SolverRequest:
    content: str
    question: str

@dataclass
class IntermediateSolverResponse:
    content: str
    question: str
    answer: str
    round: int
    sender: str

@dataclass
class FinalSolverResponse:
    answer: str
    sender: str

# =====================================================================
# 2. Event-Driven Message Router (Simulating AutoGen Runtime)
# =====================================================================

class MessageRouter:
    """
    A lightweight, asynchronous message broker that implements 
    publish-subscribe routing and agent registration, mimicking AutoGen.
    """
    def __init__(self):
        self._agents: Dict[str, Any] = {}
        # Maps topic_name -> list of subscriber agent names
        self._subscriptions: Dict[str, List[str]] = collections.defaultdict(list)

    def register_agent(self, name: str, agent: Any):
        self._agents[name] = agent
        agent.router = self
        agent.name = name

    def add_subscription(self, topic_type: str, subscriber_name: str):
        self._subscriptions[topic_type].append(subscriber_name)

    async def publish_message(self, message: Any, topic_type: str = "default"):
        """Publishes a message to all agents subscribed to a topic."""
        subscribers = self._subscriptions.get(topic_type, [])
        tasks = []
        for sub_name in subscribers:
            if sub_name in self._agents:
                agent = self._agents[sub_name]
                tasks.append(agent.receive_message(message))
        if tasks:
            await asyncio.gather(*tasks)

    async def send_message(self, message: Any, recipient_name: str):
        """Sends a direct message to a specific agent."""
        if recipient_name in self._agents:
            await self._agents[recipient_name].receive_message(message)


# =====================================================================
# 3. Base Agent Implementation
# =====================================================================

class BaseAgent:
    """Base Agent class with messaging helpers."""
    def __init__(self, description: str = ""):
        self.description = description
        self.router: MessageRouter = None
        self.name: str = ""

    async def publish_message(self, message: Any, topic_type: str = "default"):
        if self.router:
            await self.router.publish_message(message, topic_type)

    async def send_message(self, message: Any, recipient_name: str):
        if self.router:
            await self.router.send_message(message, recipient_name)

    async def receive_message(self, message: Any):
        """Dispatches messages to registered handlers based on type."""
        handler_name = f"handle_{type(message).__name__.lower()}"
        handler = getattr(self, handler_name, None)
        if handler:
            await handler(message)


# =====================================================================
# 4. Math Solver Agent (The Debater)
# =====================================================================

class MathSolver(BaseAgent):
    """
    A solver agent that solves mathematical problems and refines its
    answers iteratively based on responses from neighboring agents.
    """
    def __init__(self, topic_type: str, num_neighbors: int, max_round: int, llm_engine: Callable = None):
        super().__init__("A mathematical debater in a ring network.")
        self._topic_type = topic_type
        self._num_neighbors = num_neighbors
        self._max_round = max_round
        self._round = 0
        
        # Buffer to collect neighbor responses per round
        self._buffer: Dict[int, List[IntermediateSolverResponse]] = {}
        
        # Keeps track of local memory/history
        self._history: List[str] = []
        self._llm_engine = llm_engine

    async def handle_solverrequest(self, message: SolverRequest):
        # Add the incoming question/prompt to local memory
        self._history.append(message.content)
        
        # Generate the answer using the designated LLM engine
        response_content = await self._llm_engine(self.name, self._history, self._round)
        self._history.append(response_content)
        
        # Print colored logs for execution tracking
        color_code = {
            "MathSolverA": "\033[94m",  # Blue
            "MathSolverB": "\033[92m",  # Green
            "MathSolverC": "\033[93m",  # Yellow
            "MathSolverD": "\033[95m"   # Magenta
        }.get(self.name, "\033[0m")
        
        print(f"{color_code}{'='*80}\n"
              f"[{self.name}] Round {self._round} Generation:\n"
              f"{response_content}\033[0m")

        # Parse final answer from format {{answer}}
        match = re.search(r"\{\{(\-?\d+(\.\d+)?)\}\}", response_content)
        if match is None:
            # Fallback to general integer extraction if format is missed
            match = re.search(r"(\d+)", response_content)
            answer = match.group(1) if match else "0"
        else:
            answer = match.group(1)

        self._round += 1

        if self._round == self._max_round:
            # Reached max rounds, publish final answer to default topic (Aggregator listening)
            await self.publish_message(FinalSolverResponse(answer=answer, sender=self.name), topic_type="default")
        else:
            # Publish intermediate response to this agent's topic (Neighbors listening)
            await self.publish_message(
                IntermediateSolverResponse(
                    content=response_content,
                    question=message.question,
                    answer=answer,
                    round=self._round,
                    sender=self.name
                ),
                topic_type=self._topic_type
            )

    async def handle_intermediatesolverresponse(self, message: IntermediateSolverResponse):
        # Store peer responses in buffer grouped by round
        self._buffer.setdefault(message.round, []).append(message)
        
        # Trigger next step once all neighboring solvers have checked in
        if len(self._buffer[message.round]) == self._num_neighbors:
            print(f"\033[90m[{self.name}] Received all responses from {self._num_neighbors} neighbors for Round {message.round}.\033[0m")
            
            # Construct the collaborative context prompt
            prompt = "These are the solutions to the problem from neighboring agents in the ring:\n"
            for resp in self._buffer[message.round]:
                prompt += f"- Solver {resp.sender} suggests: {resp.content}\n"
                
            prompt += (
                "\nUsing the solutions from neighboring agents as additional context and critique, "
                "re-evaluate your reasoning. If your original answer was incorrect, self-correct. "
                f"The original problem is: {message.question}. "
                "Limit your response to 80 words. Your final answer must be a single numerical "
                "value wrapped in double curly braces, like {{answer}} at the end of your response."
            )
            
            # Direct self-message to trigger generation with updated context
            await self.send_message(SolverRequest(content=prompt, question=message.question), self.name)
            self._buffer.pop(message.round)


# =====================================================================
# 5. Math Aggregator Agent (The Judge/Orchestrator)
# =====================================================================

class MathAggregator(BaseAgent):
    """
    Orchestrator agent that distributes tasks, gathers final answers,
    and resolves the final decision via majority voting.
    """
    def __init__(self, num_solvers: int):
        super().__init__("The Central Moderator and Voting Aggregator.")
        self._num_solvers = num_solvers
        self._final_responses: List[FinalSolverResponse] = []

    async def handle_question(self, message: Question):
        print(f"\n\033[1m[Aggregator] Received Question:\n{message.content}\033[0m\n")
        
        prompt = (
            f"Can you solve the following math problem?\n{message.content}\n\n"
            "Explain your reasoning concisely. Your final answer should be a single numerical "
            "value wrapped in double curly braces, like {{answer}} at the end of your response."
        )
        
        print(f"\033[1m[Aggregator] Distributing task to all {self._num_solvers} solvers...\033[0m")
        # Broadcast the initial solver request to default topic (All solvers listen to default)
        await self.publish_message(SolverRequest(content=prompt, question=message.content), topic_type="default")

    async def handle_finalsolverresponse(self, message: FinalSolverResponse):
        self._final_responses.append(message)
        
        if len(self._final_responses) == self._num_solvers:
            print(f"\n\033[1m[Aggregator] Received all {self._num_solvers} final answers.\033[0m")
            
            # Extract answers
            answers = [resp.answer for resp in self._final_responses]
            for resp in self._final_responses:
                print(f" - Solver {resp.sender} submitted final answer: {resp.answer}")
                
            # Perform majority voting resolution
            majority_answer = max(set(answers), key=answers.count)
            print(f"\n\033[1;32m[Aggregator] Voting Resolution: {answers} -> Majority Choice is {majority_answer}\033[0m")
            
            # Publish consolidated final system answer
            await self.publish_message(Answer(content=majority_answer), topic_type="final_result")
            self._final_responses.clear()


# =====================================================================
# 6. Mock LLM Engine with Evolutionary Self-Correction Behavior
# =====================================================================

async def mock_llm_engine(agent_name: str, history: List[str], round_num: int) -> str:
    """
    Simulates real LLM generations, introducing errors in Round 0 
    and showing how agents correct themselves during Round 1 and 2
    by looking at their neighbors' outputs.
    """
    await asyncio.sleep(0.1)  # Simulate API latency
    
    # Simple logic-based mock scenarios
    if round_num == 0:
        # We start with some agents making mistakes, and some getting it right
        if agent_name == "MathSolverA":
            return "First, let's look at April: 48 friends. In May, she sold half of that: 48 / 2 = 24. Total is 48 + 24 = 72. The answer is {{72}}."
        elif agent_name == "MathSolverB":
            # Solver B makes a calculation mistake
            return "Natalia sold 48 clips. In May she sold half as many which is 48 - 24 = 24. But wait, total should be 48 + 12 = 60. The answer is {{60}}."
        elif agent_name == "MathSolverC":
            # Solver C also makes a mistake
            return "Let's compute: 48 in April. In May she sold half as many: 48 / 2 = 24. No wait, April is 48, May is half of April's remaining? Let's say 24 / 2 = 12. Total 48 + 12 = 60. The answer is {{60}}."
        elif agent_name == "MathSolverD":
            return "April sold 48 clips. May is half of 48, which is 24. So total sold across both months is 48 + 24 = 72. The answer is {{72}}."

    # In Round 1 or 2, agents re-evaluate based on neighbors
    # For a Ring Topology:
    # A's neighbors: B and D
    # B's neighbors: A and C
    # C's neighbors: B and D
    # D's neighbors: C and A
    
    # We can inspect the history to see neighbors' answers
    last_context = history[-1]
    
    if agent_name in ["MathSolverB", "MathSolverC"]:
        # They will notice 72 suggested by neighbors (A or D)
        if "72" in last_context:
            return (
                f"Checking peer solutions. Solver A and Solver D make a compelling case: "
                f"half of 48 is indeed 24, not 12. Therefore, 48 + 24 = 72. "
                f"I realize my calculation error. The correct sum is {{{{72}}}}."
            )
            # note the {{{{72}}}} translates to {{72}} inside f-string
        else:
            return f"I stand by my original reasoning. The answer is {{{{60}}}}."
    else:
        # A and D are already correct, they see 60 but stick to their mathematically verified 72
        return (
            f"I review my neighbors' suggestions of 60. However, the math remains: "
            f"48 sold in April, half of 48 is 24 sold in May. 48 + 24 = 72. "
            f"The suggestions of 60 are incorrect because they halved 24 instead of 48. "
            f"I confidently stick to {{{{72}}}}."
        )


# =====================================================================
# 7. Setup and Run the Ring-Topology Debate System
# =====================================================================

async def main():
    print("Initializing Multi-Agent Debate System with Sparse Ring Topology...")
    
    router = MessageRouter()
    
    # Create 4 solver agents and 1 aggregator
    solvers = {
        "MathSolverA": MathSolver(topic_type="MathSolverA", num_neighbors=2, max_round=3, llm_engine=mock_llm_engine),
        "MathSolverB": MathSolver(topic_type="MathSolverB", num_neighbors=2, max_round=3, llm_engine=mock_llm_engine),
        "MathSolverC": MathSolver(topic_type="MathSolverC", num_neighbors=2, max_round=3, llm_engine=mock_llm_engine),
        "MathSolverD": MathSolver(topic_type="MathSolverD", num_neighbors=2, max_round=3, llm_engine=mock_llm_engine),
    }
    aggregator = MathAggregator(num_solvers=4)
    
    # Register all agents in router
    for name, agent in solvers.items():
        router.register_agent(name, agent)
    router.register_agent("MathAggregator", aggregator)
    
    # Setup Sparse Ring Topology: A <-> B <-> C <-> D <-> A
    # Subscription translates to: "Who receives my intermediate messages?"
    # MathSolverA publishes to "MathSolverA". Neighbor D and Neighbor B listen to it.
    router.add_subscription("MathSolverA", "MathSolverD")
    router.add_subscription("MathSolverA", "MathSolverB")
    
    # MathSolverB publishes to "MathSolverB". Neighbor A and Neighbor C listen to it.
    router.add_subscription("MathSolverB", "MathSolverA")
    router.add_subscription("MathSolverB", "MathSolverC")
    
    # MathSolverC publishes to "MathSolverC". Neighbor B and Neighbor D listen to it.
    router.add_subscription("MathSolverC", "MathSolverB")
    router.add_subscription("MathSolverC", "MathSolverD")
    
    # MathSolverD publishes to "MathSolverD". Neighbor C and Neighbor A listen to it.
    router.add_subscription("MathSolverD", "MathSolverC")
    router.add_subscription("MathSolverD", "MathSolverA")
    
    # All solvers and the aggregator subscribe to the default topic (for broadcast requests/final responses)
    for name in solvers.keys():
        router.add_subscription("default", name)
    router.add_subscription("default", "MathAggregator")
    
    # The aggregator also listens to the solvers' final responses on the default topic
    # (Since solvers publish FinalSolverResponse to DefaultTopicId in AutoGen)
    
    # Define a test question (GSM8K problem)
    test_question = Question(
        content="Natalia sold clips to 48 of her friends in April, and then she sold half as many clips in May. "
                "How many clips did Natalia sell altogether in April and May?"
    )
    
    # Publish question to start the entire event chain
    await router.publish_message(test_question, topic_type="default")


if __name__ == "__main__":
    asyncio.run(main())
